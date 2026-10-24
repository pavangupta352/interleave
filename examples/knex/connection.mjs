import net from 'node:net';
import knex from 'knex';

/**
 * One actor owns one Knex instance whose pool holds one connection. The
 * operation must await its queries and cooperate with context.signal for
 * non-database work.
 */
export async function withKnexActor(context, operation) {
  context.signal.throwIfAborted();
  // node-postgres's public `stream` option hands every socket this actor opens
  // to the helper. Knex passes its connection object to pg's Client unchanged.
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
  // Knex's default pool keeps at least two connections; tarn rejects min > max.
  const db = knex({ client: 'pg', pool: { min: 0, max: 1 },
    connection: { connectionString: context.connectionString, application_name: 'interleave-knex', stream } });
  let value, failure, failed = false;
  context.signal.addEventListener('abort', destroySockets, { once: true });
  try {
    value = await operation(db);
    context.signal.throwIfAborted();
  } catch (error) { failed = true; failure = error; }
  finally {
    context.signal.removeEventListener('abort', destroySockets);
    const cleanupErrors = [];
    try { await db.destroy(); }
    catch (error) { cleanupErrors.push(error); }
    // destroy() ends every pooled connection. No socket of this actor may
    // outlive the helper, so anything still open is destroyed and awaited.
    const open = [...sockets];
    for (const socket of open) socket.destroy();
    await Promise.all(open.map(socket => new Promise(resolve => socket.once('close', resolve))));
    if (cleanupErrors.length) {
      failure = new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
        'Knex actor cleanup failed', { cause: failed ? failure : cleanupErrors[0] });
      failed = true;
    }
  }
  if (failed) throw failure;
  return value;
}
