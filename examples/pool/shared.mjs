import assert from 'node:assert/strict';
import pg from 'pg';

/** One request handler: it adds two items at once through its own pool, as `Promise.all` code often does. */
export function handler(addOne) {
  return async ({ connectionString }) => {
    const pool = new pg.Pool({ connectionString, max: 2 });
    // A closed actor endpoint surfaces through the pending queries themselves.
    pool.on('error', () => undefined);
    try {
      await Promise.all([addOne(pool), addOne(pool)]);
    } finally {
      await pool.end();
    }
  };
}

export async function setup({ db }) {
  await db.query('CREATE TABLE counters (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counters VALUES (1, 0)');
}

export async function invariant({ db }) {
  const { rows } = await db.query('SELECT value FROM counters WHERE id = 1');
  assert.equal(rows[0].value, 4, 'Every pooled increment must be retained');
}
