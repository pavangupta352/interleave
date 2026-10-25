import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const java = process.env.INTERLEAVE_TEST_JAVA!;
const program = fileURLToPath(new URL('./fixtures/process/ProtocolFeatures.java', import.meta.url));
const jar = fileURLToPath(new URL('../examples/java/lib/postgresql-42.7.13.jar', import.meta.url));
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

test('pgjdbc fetch-size cursors, setQueryTimeout and CopyManager run through an actor and replay', { timeout: 180_000 }, async () => {
  // The Java example's script downloads and verifies the pinned driver jar.
  const fetched = spawnSync(process.execPath, [fileURLToPath(new URL('../examples/java/fetch-driver.mjs', import.meta.url))], { encoding: 'utf8' });
  expect(fetched.status, fetched.stderr).toBe(0);
  const owned: string[] = [];
  const scenario: Scenario = {
    name: 'pgjdbc protocol features',
    async setup({ db, connectionString }) {
      owned.push(new URL(connectionString).pathname.slice(1));
      await db.query('CREATE TABLE items (id integer PRIMARY KEY); INSERT INTO items SELECT generate_series(1, 5)');
    },
    actors: { alice: processActor(java, ['-cp', jar, program]), async bob() {} },
    async invariant({ db }) { assert.equal((await db.query('SELECT count(*)::int AS rows FROM items')).rows[0].rows, 7); },
  };
  try {
    const first = await runOnce(scenario, { databaseUrl, timeoutMs: 60_000 });
    expect(first.outcome, first.reason).toBe('passed');
    expect(parseRunArtifact(first)).toEqual(first);
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toEqual({ ids: [1, 2, 3, 4, 5], timeout: '57014', copied: 2, out: '1 2 3 4 5 6 7' });
    // With a fetch size inside a transaction, pgjdbc fetches each batch in its own Sync cycle.
    expect(first.trace.filter(step => step.sql === 'SELECT id FROM items ORDER BY id')).toHaveLength(3);
    // The query timeout's cancel request reached the sleeping statement.
    const sleeping = first.trace.findIndex(step => step.sql === 'SELECT pg_sleep(30)');
    expect(first.trace[sleeping]!.completion?.error?.code).toBe('57014');
    expect(first.cancels).toEqual([{ at: expect.any(Number), actor: 'alice', backendPid: first.trace[sleeping]!.backendPid, forwarded: true, connection: 0, step: sleeping }]);
    const copies = first.trace.flatMap(step => step.completion?.kind !== 'metadata' ? step.completion?.copy ?? [] : []);
    expect(copies).toEqual([
      { direction: 'in', bytes: 4, sha256: sha256('6\n7\n') },
      { direction: 'out', bytes: 14, sha256: sha256('1\n2\n3\n4\n5\n6\n7\n') },
    ]);
    const repeated = await replay(scenario, first, { databaseUrl, timeoutMs: 60_000 });
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
