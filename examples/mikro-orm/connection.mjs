import net from 'node:net';
import { MikroORM } from '@mikro-orm/postgresql';

/**
 * One actor owns one MikroORM instance whose pool holds one connection. The
 * operation receives a forked EntityManager, must await its queries and must
 * cooperate with context.signal for non-database work.
 */
export async function withMikroOrmActor(context, entities, operation) {
  context.signal.throwIfAborted();
  // node-postgres's public `stream` option hands every socket this actor opens
  // to the helper. MikroORM passes driverOptions.connection through Knex to
  // pg's Client unchanged.
  const sockets = new Set();
  const stream = () => {
    context.signal.throwIfAborted();
    const socket = new net.Socket();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  // Destroying a socket rejects its pending command at once, even while the
  // proxy still holds that command unreleased.
  const destroySockets = () => { for (const socket of sockets) socket.destroy(); };
  let orm, value, failure, failed = false;
  context.signal.addEventListener('abort', destroySockets, { once: true });
  try {
    orm = await MikroORM.init({
      clientUrl: context.connectionString, entities,
      // init() then connect() sends the same commands as the default init(),
      // and the helper owns the ORM before the first of them.
      connect: false,
      // The default check inlines the generated database name in its SQL, so
      // exact replay of a recorded run could never match it. See README.md.
      ensureDatabase: false,
      pool: { min: 0, max: 1 },
      driverOptions: { connection: { application_name: 'interleave-mikro-orm', stream } },
    });
    await orm.connect();
    context.signal.throwIfAborted();
    value = await operation(orm.em.fork());
    context.signal.throwIfAborted();
  } catch (error) { failed = true; failure = error; }
  finally {
    context.signal.removeEventListener('abort', destroySockets);
    const cleanupErrors = [];
    try { if (orm) await orm.close(true); }
    catch (error) { cleanupErrors.push(error); }
    // close() ends every pooled connection. No socket of this actor may
    // outlive the helper, so anything still open is destroyed and awaited.
    const open = [...sockets];
    for (const socket of open) socket.destroy();
    await Promise.all(open.map(socket => new Promise(resolve => socket.once('close', resolve))));
    if (cleanupErrors.length) {
      failure = new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
        'MikroORM actor cleanup failed', { cause: failed ? failure : cleanupErrors[0] });
      failed = true;
    }
  }
  if (failed) throw failure;
  return value;
}
