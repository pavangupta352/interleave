import assert from 'node:assert/strict';
import { Client } from 'pg';
import { runOnce } from '../runner.js';
import type { RunOptions, RunResult, Scenario } from '../types.js';

export async function doctor(options: RunOptions): Promise<RunResult> {
  const query = (value: number): Scenario['actors'][string] => async ({ connectionString }) => {
    const client = new Client({ connectionString });
    client.on('error', () => undefined);
    await client.connect();
    try { return (await client.query('SELECT $1::int AS checked', [value])).rows[0].checked; }
    finally { await client.end(); }
  };
  return runOnce({
    name: 'interleave-doctor',
    async setup({ db }) { assert.match((await db.query('SELECT current_database() AS name')).rows[0].name, /^interleave_[a-f0-9]+$/); },
    actors: { alice: query(1), bob: query(2) },
    async invariant({ results }) { assert.deepEqual(results.map(result => result.value), [1, 2]); },
  }, options);
}
