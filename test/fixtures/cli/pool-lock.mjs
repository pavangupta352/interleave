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

export default {
  name: 'pool-own-connection-lock',
  async setup({ db }) { await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1, 0), (2, 0)'); },
  actors: {
    // The transaction connection holds a row lock that the pool's side query waits for.
    alice: context => withPool(context, async pool => {
      const transaction = await pool.connect();
      try {
        await transaction.query('BEGIN');
        await transaction.query('UPDATE counter SET value = value + 1 WHERE id = 1');
        const side = pool.query('UPDATE counter SET value = value + 10 WHERE id = 1');
        await transaction.query('COMMIT');
        await side;
      } finally { transaction.release(); }
    }),
    bob: context => withPool(context, async pool => (await pool.query('SELECT value FROM counter WHERE id = 2')).rows[0].value, 1),
  },
  async invariant({ db }) {
    assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 11, 'Both of alice\'s updates must commit');
  },
};
