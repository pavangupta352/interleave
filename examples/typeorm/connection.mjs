import pg from 'pg';
import { DataSource } from 'typeorm';

/**
 * One actor owns one PostgreSQL DataSource and QueryRunner. The operation must
 * await its queries and cooperate with context.signal for non-database work.
 */
export async function withTypeOrmActor(context, entities, operation) {
  context.signal.throwIfAborted();
  const pools = new Set(), leases = new Set(), clients = new Map();
  let connectionError;
  const interruption = () => context.signal.aborted ? context.signal.reason : connectionError;
  const abort = () => { for (const release of leases) release(true); };
  const onError = error => { connectionError ??= error; abort(); };

  // TypeORM's public driver option captures ownership before initialize has
  // returned. No global pg mutation or access to TypeORM's internal pool.
  class ActorPool extends pg.Pool {
    #closed;
    constructor(options) {
      super(options);
      pools.add(this);
      this.on('error', onError);
      this.on('connect', client => {
        client.on('error', onError);
        clients.set(client, new Promise(resolve => client.once('end', () => {
          clients.delete(client); client.off('error', onError); resolve();
        })));
      });
    }
    connect(callback) {
      if (!callback) return new Promise((resolve, reject) => this.connect((error, client, release) => {
        if (error) reject(error);
        else { client.release = release; resolve(client); }
      }));
      return super.connect((error, client, release) => {
        if (error) { callback(error); return; }
        let released = false;
        const releaseOnce = error => {
          if (released) return;
          released = true; leases.delete(releaseOnce); release(error);
        };
        leases.add(releaseOnce);
        // Acquisition itself has pg's five-second timeout. A late connection
        // belongs to this actor even when cancellation preceded its arrival.
        const stopped = interruption();
        if (context.signal.aborted || connectionError) { releaseOnce(true); callback(stopped); }
        else callback(undefined, client, releaseOnce);
      });
    }
    end(callback) {
      this.#closed ??= super.end();
      if (callback) { void this.#closed.then(() => callback(), callback); return; }
      return this.#closed;
    }
  }

  const source = new DataSource({ type: 'postgres', url: context.connectionString,
    entities, driver: { ...pg, Pool: ActorPool }, poolSize: 1, connectTimeoutMS: 5000,
    applicationName: 'interleave-typeorm', poolErrorHandler: onError,
    synchronize: false, migrationsRun: false, installExtensions: false });
  let runner, value, failure, failed = false;
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    context.signal.throwIfAborted();
    await source.initialize();
    runner = source.createQueryRunner();
    await runner.connect();
    context.signal.throwIfAborted();
    value = await operation(runner);
    context.signal.throwIfAborted();
    if (connectionError) throw connectionError;
  } catch (error) { failed = true; failure = error; }
  finally {
    const cleanupErrors = [];
    try { if (runner && !runner.isReleased) await runner.release(); }
    catch (error) { cleanupErrors.push(error); }
    // Initialization can fail before isInitialized becomes true. Its acquired
    // clients still have public release callbacks owned by this invocation.
    abort();
    try { if (source.isInitialized) await source.destroy(); }
    catch (error) { cleanupErrors.push(error); }
    for (const pool of pools) {
      try { await pool.end(); }
      catch (error) { cleanupErrors.push(error); }
      finally { pool.off('error', onError); }
    }
    await Promise.all(clients.values());
    context.signal.removeEventListener('abort', abort);
    if (cleanupErrors.length) {
      failure = new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
        'TypeORM actor cleanup failed', { cause: failed ? failure : cleanupErrors[0] });
      failed = true;
    }
  }
  if (failed) throw failure;
  return value;
}
