import assert from 'node:assert/strict';
import pg from 'pg';

// Each actor records whether its own upstream backend is encrypted, then performs an
// unsafe read-modify-write. Extra setup/invariant clients use the strict context options.
async function increment({ connectionString }) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: [encrypted] } = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    const { rows: [counter] } = await client.query('SELECT value FROM counter WHERE id = 1');
    await client.query('UPDATE counter SET value = $1 WHERE id = 1', [counter.value + 1]);
    return { ssl: encrypted.ssl };
  } finally { await client.end(); }
}

async function encrypted(connectionOptions) {
  const client = new pg.Client(connectionOptions);
  await client.connect();
  try { return (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0].ssl; }
  finally { await client.end(); }
}

export default {
  name: 'tls-counter',
  async setup({ db, connectionOptions }) {
    assert.equal(await encrypted(connectionOptions), true);
    await db.query('CREATE TABLE counter (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO counter VALUES (1, 0)');
  },
  actors: { alice: increment, bob: increment },
  async invariant({ db, connectionOptions }) {
    assert.equal(await encrypted(connectionOptions), true);
    assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 2, 'both increments survive');
  },
};
