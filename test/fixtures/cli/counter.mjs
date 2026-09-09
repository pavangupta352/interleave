import assert from 'node:assert/strict';
import { Client } from 'pg';
const increment = async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try {
    const { rows } = await client.query('SELECT value FROM counter');
    await client.query('UPDATE counter SET value = $1', [rows[0].value + 1]);
  } finally { await client.end(); }
};
export default {
  name: 'cli-counter',
  async setup({ db }) { console.log('CLI_SCENARIO_LOG_NOT_JSON'); await db.query('CREATE TABLE counter (value int); INSERT INTO counter VALUES (0)'); },
  actors: { alice: increment, bob: increment },
  async invariant({ db }) { assert.equal((await db.query('SELECT value FROM counter')).rows[0].value, 2, 'Both increments survive'); },
};
