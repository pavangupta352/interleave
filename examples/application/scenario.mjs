import assert from 'node:assert/strict';
import { Client } from 'pg';
import { defineScenario } from '@pavangupta352/interleave';
import { incrementCounter } from './counter.mjs';

async function increment({ connectionString }) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return { value: await incrementCounter(client, 1) };
  } finally {
    await client.end();
  }
}

export default defineScenario({
  name: 'application-counter',
  async setup({ db }) {
    await db.query('CREATE TABLE counters (id int PRIMARY KEY, value int NOT NULL)');
    await db.query('INSERT INTO counters VALUES (1, 0)');
  },
  actors: { alice: increment, bob: increment },
  async invariant({ db, results }) {
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.status === 'fulfilled'));
    const { rows } = await db.query('SELECT value FROM counters WHERE id = 1');
    assert.equal(rows[0].value, 2, 'Both increments must be retained');
  },
});
