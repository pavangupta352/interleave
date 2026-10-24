import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';

const { Client, Query } = pg;
/** What libpq's PQcancel sends; backend 1 is never one of an actor's connections. */
async function cancelBackend(connectionString, pid, secret) {
  const url = new URL(connectionString);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  socket.on('error', () => {});
  await once(socket, 'connect');
  const packet = Buffer.alloc(16);
  packet.writeInt32BE(16); packet.writeInt32BE(80877102, 4); packet.writeInt32BE(pid, 8); packet.writeInt32BE(secret, 12);
  socket.write(packet); socket.resume();
  await once(socket, 'close');
}
export default {
  name: 'cli-cancel',
  async setup({ db }) { await db.query("CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL); INSERT INTO notes VALUES (1, 'draft')"); },
  actors: {
    async alice({ connectionString }) {
      const client = new Client({ connectionString }); client.on('error', () => {}); await client.connect();
      try {
        await cancelBackend(connectionString, 1, 0);
        const query = client.query(new Query('SELECT pg_sleep(30)'));
        const settled = new Promise(resolve => { query.once('error', error => resolve(error.code)); query.once('end', () => resolve('completed')); });
        // node-postgres sends the request from a new client with the same settings.
        const timer = setTimeout(() => new Client({ connectionString }).cancel(client, query), 300);
        try { return await settled; } finally { clearTimeout(timer); }
      } finally { await client.end(); }
    },
    async bob({ connectionString }) {
      const client = new Client({ connectionString }); await client.connect();
      try { await client.query("UPDATE notes SET body = 'final' WHERE id = 1"); } finally { await client.end(); }
    },
  },
  async invariant({ db, results }) {
    assert.equal(results.find(result => result.actor === 'alice')?.value, '57014', 'The sleeping statement was cancelled');
    assert.equal((await db.query('SELECT body FROM notes WHERE id = 1')).rows[0].body, 'final');
  },
};
