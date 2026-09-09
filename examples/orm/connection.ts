import { Pool, type Client } from 'pg';
import type { ActorContext } from '../../src/types.js';

/** Each actor owns its Pool, including checked-out connections during abort. */
export async function withActorPool<T>(context: ActorContext, prepare: (pool: Pool) => {
  run(): Promise<T>; close?(): Promise<void>;
}): Promise<T> {
  const pool = new Pool({ connectionString: context.connectionString, max: 1,
    connectionTimeoutMillis: 5000, application_name: 'interleave-ordinary-orm' });
  const clients = new Map<Client, Promise<void>>();
  const stopping = new WeakSet<Client>();
  let interrupted = false;
  let connectionError: Error | undefined;
  let close = () => pool.end();
  const stop = (client: Client): void => {
    if (stopping.has(client)) return;
    stopping.add(client);
    void client.end().catch(error => { connectionError ??= error; });
  };
  const abort = (): void => { interrupted = true; for (const client of clients.keys()) stop(client); };
  const onError = (error: Error): void => { connectionError ??= error; abort(); };
  pool.on('error', onError);
  pool.on('connect', client => {
    client.on('error', onError);
    clients.set(client, new Promise<void>(resolve => client.once('end', () => {
      clients.delete(client); client.off('error', onError); resolve();
    })));
    if (interrupted) stop(client);
  });
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    context.signal.throwIfAborted();
    const operation = prepare(pool);
    if (operation.close) close = operation.close;
    const result = await operation.run();
    if (connectionError) throw connectionError;
    return result;
  } finally {
    context.signal.removeEventListener('abort', abort);
    // Let acquisition/query release finish before ending the Pool. In particular,
    // Kysely still needs its Pool while an interrupted acquisition unwinds.
    try { await close(); await Promise.all(clients.values()); }
    finally { pool.off('error', onError); }
  }
}
