import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import type { Scenario } from '../../../src/types.js';
const changed: Scenario['actors'][string] = async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try { await client.query('SELECT 42'); } finally { await client.end(); }
};
const increment: Scenario['actors'][string] = async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try {
    const { rows } = await client.query('SELECT value FROM counter WHERE id = 1');
    await client.query('UPDATE counter SET value = $1 WHERE id = 1', [Number(rows[0].value) + 1]);
  } finally { await client.end(); }
};
export default {
  name: 'supervised-counter',
  async setup({ db }) { await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int); INSERT INTO counter VALUES (1, 0)'); },
  actors: { alice: changed, bob: increment },
  async invariant({ db }) { assert.equal((await db.query('SELECT value FROM counter')).rows[0].value, 2); },
} satisfies Scenario;
