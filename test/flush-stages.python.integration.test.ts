import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { Client } from 'pg';
import { parseRunArtifact } from '../src/artifact.js';
import { processActor } from '../src/process-actor.js';
import { replay } from '../src/replay.js';
import { runOnce } from '../src/runner.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const python = process.env.INTERLEAVE_TEST_PYTHON!;
const program = fileURLToPath(new URL('./fixtures/process/pipeline_flush.py', import.meta.url));

test('a libpq pipeline with a flush request holds its implicit transaction open until its Sync', { timeout: 120_000 }, async () => {
  const owned: string[] = [];
  const scenario: Scenario = {
    name: 'pipeline flush',
    async setup({ db, connectionString }) {
      owned.push(new URL(connectionString).pathname.slice(1));
      await db.query('CREATE TABLE items (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO items VALUES (1, 10), (2, 20)');
    },
    actors: {
      alice: processActor(python, [program]),
      async bob({ connectionString }) {
        const client = new Client({ connectionString }); client.on('error', () => {}); await client.connect();
        try { await client.query('UPDATE items SET value = value + 100 WHERE id = 1'); } finally { await client.end(); }
      },
    },
    async invariant({ db }) { assert.equal((await db.query('SELECT value FROM items WHERE id = 1')).rows[0].value, 111); },
  };
  try {
    const refused = await runOnce(scenario, { databaseUrl });
    expect(refused.outcome).toBe('inconclusive');
    expect(refused.reason).toMatch(/select protocol profile flush-stages-v1/);
    const first = await runOnce(scenario, { databaseUrl, protocolProfile: 'flush-stages-v1', plan: ['alice', 'bob', 'alice'] });
    expect(first.outcome, first.reason).toBe('passed');
    expect(parseRunArtifact(first)).toEqual(first);
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toEqual([11, 31]);
    expect(first.trace.map(step => `${step.actor}:${step.stage}`)).toEqual(['alice:flush', 'bob:complete', 'alice:sync']);
    expect(first.trace[0]!.completion).toEqual({ kind: 'flush', commandTags: ['UPDATE 1', 'SELECT 1'], rows: 2 });
    // The UPDATE's row lock lasts until the pipeline's Sync commits it.
    expect(first.trace[1]!.waits[0]?.blockerPids).toEqual([first.trace[0]!.backendPid]);
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
