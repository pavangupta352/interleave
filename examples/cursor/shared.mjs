import assert from 'node:assert/strict';
import pg from 'pg';
import Cursor from 'pg-cursor';

/**
 * A nightly interest job: it streams accounts through a cursor, two rows per batch,
 * and writes each new balance through a second connection from the same pool.
 */
export function interestJob(applyInterest) {
  return async ({ connectionString }) => {
    const pool = new pg.Pool({ connectionString, max: 2 });
    // A closed actor endpoint surfaces through the pending queries themselves,
    // including on clients checked out of the pool.
    pool.on('error', () => undefined);
    const reader = await pool.connect();
    reader.on('error', () => undefined);
    const writer = await pool.connect();
    writer.on('error', () => undefined);
    try {
      const cursor = reader.query(new Cursor('SELECT id, balance FROM accounts ORDER BY id'));
      for (let batch = await cursor.read(2); batch.length; batch = await cursor.read(2)) {
        for (const account of batch) await applyInterest(writer, account);
      }
      await cursor.close();
    } finally {
      reader.release(); writer.release();
      await pool.end();
    }
  };
}

/** A customer deposit to account 3, committed on its own. */
export async function deposit({ connectionString }) {
  const client = new pg.Client({ connectionString });
  client.on('error', () => undefined);
  await client.connect();
  try { await client.query('UPDATE accounts SET balance = balance + 50 WHERE id = 3'); } finally { await client.end(); }
}

export async function setup({ db }) {
  await db.query('CREATE TABLE accounts (id int PRIMARY KEY, balance numeric(12, 2) NOT NULL); INSERT INTO accounts SELECT g, 100 FROM generate_series(1, 4) g');
}

export async function invariant({ db }) {
  const { rows } = await db.query('SELECT balance FROM accounts WHERE id = 3');
  // With interest at 10%, keeping the deposit leaves 160.00 or 165.00 in account 3.
  assert.ok(Number(rows[0].balance) >= 160, `The deposit to account 3 was lost; its balance is ${rows[0].balance}`);
}
