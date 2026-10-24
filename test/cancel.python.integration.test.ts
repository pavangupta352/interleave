import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Client } from 'pg';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { processActor } from '../src/process-actor.js';
import { replay } from '../src/replay.js';
import { runOnce } from '../src/runner.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const python = process.env.INTERLEAVE_TEST_PYTHON!;
const program = fileURLToPath(new URL('./fixtures/process/cancel.py', import.meta.url));

test('psycopg cancel_safe() reaches its own backend through the actor endpoint and replays', { timeout: 120_000 }, async () => {
  const owned: string[] = [];
  const scenario: Scenario = {
    name: 'psycopg cancel',
    async setup({ connectionString }) { owned.push(new URL(connectionString).pathname.slice(1)); },
    actors: { alice: processActor(python, [program]), async bob() {} },
    async invariant({ results }) { assert.equal(results.find(result => result.actor === 'alice')?.value, '57014'); },
  };
  try {
    const first = await runOnce(scenario, { databaseUrl });
    expect(first.outcome, first.reason).toBe('passed');
    expect(parseRunArtifact(first)).toEqual(first);
    const sleeping = first.trace.findIndex(step => step.sql === 'SELECT pg_sleep(30)');
    expect(first.cancels).toEqual([{ at: expect.any(Number), actor: 'alice', backendPid: first.trace[sleeping]!.backendPid, forwarded: true, connection: 0, step: sleeping }]);
    const repeated = await replay(scenario, first, { databaseUrl });
    expect(repeated.outcome, repeated.reason).toBe('passed');
  } finally {
    const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
    try {
      const leftovers = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [owned])).rows;
      for (const { datname } of leftovers) { assert.match(datname, /^interleave_[0-9a-f]{32}$/); await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`); }
      expect(leftovers).toEqual([]);
    } finally { await admin.end(); }
  }
});
