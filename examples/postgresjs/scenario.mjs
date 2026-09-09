import assert from 'node:assert/strict';
import postgres from 'postgres';

async function increment({ connectionString, signal }) {
  const sql = postgres(connectionString, { max: 1, ssl: false, fetch_types: false });
  // Stop the driver's pending transaction work when the run is interrupted.
  const abort = () => { void sql.end({ timeout: 0 }); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const [before] = await sql`SELECT value FROM counter WHERE id=${1}`;
    const [after] = await sql`UPDATE counter SET value=${before.value + 1} WHERE id=1 RETURNING value`;
    return { read: before.value, wrote: after.value };
  } finally {
    signal.removeEventListener('abort', abort);
    await sql.end({ timeout: 1 });
  }
}

export default {
  name: 'Postgres.js: two increments',
  async setup({ db }) {
    await db.query('CREATE TABLE counter (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO counter VALUES (1, 0)');
  },
  actors: { alice: increment, bob: increment },
  async invariant({ db }) {
    assert.equal((await db.query('SELECT value FROM counter WHERE id=1')).rows[0].value, 2, 'Both increments must be retained');
  },
};
