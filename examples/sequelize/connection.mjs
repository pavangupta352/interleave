import net from 'node:net';
import { Sequelize } from 'sequelize';

/**
 * One actor owns one Sequelize instance whose pool holds one connection. The
 * operation must await its queries and cooperate with context.signal for
 * non-database work.
 */
export async function withSequelizeActor(context, operation) {
  context.signal.throwIfAborted();
  // node-postgres's public `stream` option hands every socket this actor opens
  // to the helper, including the separate server-version connection that
  // Sequelize opens and closes before its pool connection.
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
  const sequelize = new Sequelize(context.connectionString, {
    dialect: 'postgres', logging: false, pool: { max: 1, min: 0 },
    dialectOptions: { application_name: 'interleave-sequelize', stream },
  });
  let value, failure, failed = false;
  context.signal.addEventListener('abort', destroySockets, { once: true });
  try {
    value = await operation(sequelize);
    context.signal.throwIfAborted();
  } catch (error) { failed = true; failure = error; }
  finally {
    context.signal.removeEventListener('abort', destroySockets);
    const cleanupErrors = [];
    try { await sequelize.close(); }
    catch (error) { cleanupErrors.push(error); }
    // close() ends every pooled connection. No socket of this actor may outlive
    // the helper, so anything still open is destroyed and awaited.
    const open = [...sockets];
    for (const socket of open) socket.destroy();
    await Promise.all(open.map(socket => new Promise(resolve => socket.once('close', resolve))));
    if (cleanupErrors.length) {
      failure = new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
        'Sequelize actor cleanup failed', { cause: failed ? failure : cleanupErrors[0] });
      failed = true;
    }
  }
  if (failed) throw failure;
  return value;
}
