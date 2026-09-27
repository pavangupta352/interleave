import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import type { Scenario } from '../../../src/types.js';
const pause: Scenario['actors'][string] = async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try { await client.query('SELECT pg_sleep(1.5)'); } finally { await client.end(); }
};
export default {
  name: 'supervised-slow-actors',
  async setup({ db }) { await db.query('CREATE TABLE marker (id int)'); },
  actors: { alice: pause, bob: pause },
  async invariant({ db }) { assert.equal((await db.query('SELECT count(*)::int AS rows FROM marker')).rows[0].rows, 0); },
} satisfies Scenario;
