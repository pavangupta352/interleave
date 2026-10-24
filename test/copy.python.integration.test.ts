import assert from 'node:assert/strict';
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
const python = process.env.INTERLEAVE_TEST_PYTHON!;
const program = fileURLToPath(new URL('./fixtures/process/copy_streams.py', import.meta.url));
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

test('psycopg copy() and libpq extended-protocol COPY stream through the actor endpoint and replay', { timeout: 120_000 }, async () => {
  const owned: string[] = [];
  const scenario: Scenario = {
    name: 'psycopg copy',
    async setup({ db, connectionString }) {
      owned.push(new URL(connectionString).pathname.slice(1));
      await db.query('CREATE TABLE items (id integer PRIMARY KEY, name text NOT NULL)');
    },
    actors: { alice: processActor(python, [program]), async bob() {} },
    async invariant({ db }) { assert.equal((await db.query('SELECT count(*)::int AS rows FROM items')).rows[0].rows, 3); },
  };
  try {
    const first = await runOnce(scenario, { databaseUrl });
    expect(first.outcome, first.reason).toBe('passed');
    expect(parseRunArtifact(first)).toEqual(first);
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toBe('1\tapple\n2\tpear\n3\tplum\n');
    const copies = first.trace.map(step => ({ protocol: step.protocol, connection: step.connection, sql: step.sql,
      copy: step.completion?.kind !== 'metadata' ? step.completion?.copy : undefined }));
    expect(copies).toEqual([
      { protocol: 'simple', connection: 0, sql: 'COPY items (id, name) FROM STDIN', copy: [{ direction: 'in', bytes: 15, sha256: sha256('1\tapple\n2\tpear\n') }] },
      { protocol: 'extended', connection: 1, sql: 'COPY items (id, name) FROM STDIN', copy: [{ direction: 'in', bytes: 7, sha256: sha256('3\tplum\n') }] },
      { protocol: 'simple', connection: 2, sql: 'COPY (SELECT id, name FROM items ORDER BY id) TO STDOUT', copy: [{ direction: 'out', bytes: 22, sha256: sha256('1\tapple\n2\tpear\n3\tplum\n') }] },
    ]);
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
