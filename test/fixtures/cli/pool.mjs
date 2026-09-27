import assert from 'node:assert/strict';
import { Pool } from 'pg';

/** An actor-owned pg.Pool, ended after the operation and on cancellation. */
async function withPool({ connectionString, signal }, work, max = 2) {
  const pool = new Pool({ connectionString, max });
  pool.on('error', () => undefined);
  pool.on('connect', client => { client.on('error', () => undefined); });
  let ended;
  const end = () => (ended ??= pool.end().catch(() => undefined));
  signal.addEventListener('abort', end, { once: true });
  try { return await work(pool); } finally {
    signal.removeEventListener('abort', end);
    await end();
  }
}

async function increment(pool) {
  const { rows } = await pool.query('SELECT value FROM counter WHERE id = 1');
  await pool.query('UPDATE counter SET value = $1 WHERE id = 1', [rows[0].value + 1]);
  return rows[0].value;
}

export default {
  name: 'cli-pool',
  async setup({ db }) { await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1, 0)'); },
  actors: {
    // Two concurrent read-modify-writes through one pool: two command connections.
    alice: context => withPool(context, pool => Promise.all([increment(pool), increment(pool)])),
    bob: context => withPool(context, increment, 1),
  },
  async invariant({ db }) {
    assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 3, 'Every pooled increment must be retained');
  },
};
