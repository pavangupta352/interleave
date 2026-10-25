import assert from 'node:assert/strict';
import Cursor from 'pg-cursor';
import QueryStream from 'pg-query-stream';
import postgres from 'postgres';
import { afterEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import type { ActorContext, RunResult, Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const options = { databaseUrl, protocolProfile: 'flush-stages-v1' as const };
const ownedNames = new Set<string>();
afterEach(async () => {
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  try {
    const leftovers = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [[...ownedNames]])).rows;
    for (const { datname } of leftovers) { assert.match(datname, /^interleave_[0-9a-f]{32}$/); await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`); }
    expect(leftovers).toEqual([]);
  } finally { ownedNames.clear(); await admin.end(); }
});

function checked(run: RunResult, outcome: RunResult['outcome'] = 'passed'): RunResult {
  expect(run.outcome, run.reason).toBe(outcome); expect(run.cleanup.complete).toBe(true);
  expect(run.schemaVersion).toBe(5); expect(run.limits.protocolProfile).toBe('flush-stages-v1');
  expect(parseRunArtifact(run)).toEqual(run); return run;
}
function scenario(name: string, actors: Scenario['actors'], invariant: Scenario['invariant'] = async () => {}): Scenario {
  return { name, actors, invariant, async setup({ db, connectionString }) {
    ownedNames.add(new URL(connectionString).pathname.slice(1));
    await db.query('CREATE TABLE items (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO items SELECT g, g FROM generate_series(1, 5) g');
  } };
}
async function withClient<T>({ connectionString, signal }: ActorContext, body: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString }); client.on('error', () => {});
  const abort = () => { void client.end().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  await client.connect();
  try { return await body(client); }
  finally { signal.removeEventListener('abort', abort); await client.end().catch(() => {}); }
}
const shape = (run: RunResult) => run.trace.map(step => `${step.actor}:${step.stage}${step.completion?.kind === 'flush' ? `:${step.completion.rows}${step.completion.suspended ? 's' : ''}` : ''}`);
const errorCode = (error: unknown): string => String((error as { code?: unknown }).code);
const update = (sql: string) => (context: ActorContext) => withClient(context, async client => { await client.query(sql); });

describe('flush-stages-v1 with actual cursor clients and real PostgreSQL', () => {
  test('pg-cursor batches let another actor commit between them, keep the portal snapshot, and replay exactly', async () => {
    const run = scenario('cursor batches', {
      alice: context => withClient(context, async client => {
        const cursor = client.query(new Cursor<{ value: number }>('SELECT id, value FROM items ORDER BY id'));
        const values: number[] = [];
        for (let batch = await cursor.read(2); batch.length; batch = await cursor.read(2)) values.push(...batch.map(row => row.value));
        await cursor.close();
        return values;
      }),
      bob: update('UPDATE items SET value = value + 10 WHERE id = 5'),
    });
    const first = checked(await runOnce(run, { ...options, plan: ['alice', 'alice', 'bob'] }));
    expect(shape(first)).toEqual(['alice:flush:0', 'alice:flush:2s', 'bob:complete', 'alice:flush:2s', 'alice:flush:1', 'alice:sync']);
    // The portal's snapshot predates bob's committed update.
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toEqual([1, 2, 3, 4, 5]);
    expect(first.trace.filter(step => step.actor === 'alice').map(step => [step.cycle, step.prefixOrdinal])).toEqual([[0, undefined], [0, 0], [0, 1], [0, 2], [0, 3]]);
    expect(first.trace[4]!.completion).toEqual({ kind: 'flush', commandTags: ['SELECT 1'], rows: 1 });
    const repeated = checked(await replay(run, first, { databaseUrl }));
    expect(repeated.trace.map(step => step.fingerprint)).toEqual(first.trace.map(step => step.fingerprint));
    const serial = checked(await runOnce(run, { ...options, plan: ['bob'] }));
    expect(serial.actors.find(actor => actor.actor === 'alice')?.value).toEqual([1, 2, 3, 4, 15]);
  }, 60_000);

  test('a cursor closed early and an error in a later batch close their cycles with Close/Sync and Sync-only recovery', async () => {
    const run = scenario('cursor close and error', {
      alice: context => withClient(context, async client => {
        const early = client.query(new Cursor<{ id: number }>('SELECT id FROM items ORDER BY id'));
        const first = await early.read(2); await early.close();
        const failing = client.query(new Cursor('SELECT 10 / (id - 4) AS ratio FROM items ORDER BY id'));
        await failing.read(2);
        const code = await failing.read(2).then(() => 'read', errorCode);
        return { first: first.map(row => row.id), code, after: (await client.query('SELECT 1 AS one')).rows[0].one };
      }),
      async bob() {},
    });
    const first = checked(await runOnce(run, options));
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toEqual({ first: [1, 2], code: '22012', after: 1 });
    expect(shape(first)).toEqual(['alice:flush:0', 'alice:flush:2s', 'alice:sync', 'alice:flush:0', 'alice:flush:2s', 'alice:flush:1', 'alice:recover', 'alice:complete']);
    const failed = first.trace[5]!;
    expect(failed.completion).toMatchObject({ kind: 'flush', rows: 1, error: { code: '22012' } });
    expect(first.trace[6]!.completion).toMatchObject({ kind: 'ready', transactionStatus: 'I', error: { code: '22012' } });
    expect(first.trace.map(step => step.cycle)).toEqual([0, 0, 0, 1, 1, 1, 1, 2]);
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);

  test('a cursor the application abandons leaves its cycle open, with or without ending the client, and replays', async () => {
    const abandon = (end: boolean) => async ({ connectionString }: ActorContext) => {
      const client = new Client({ connectionString }); client.on('error', () => {}); await client.connect();
      const cursor = client.query(new Cursor<{ id: number }>('SELECT id FROM items ORDER BY id'));
      const first = (await cursor.read(2)).map(row => row.id);
      if (end) await client.end();
      return first;
    };
    const run = scenario('abandoned cursors', { alice: abandon(true), bob: abandon(false) });
    const first = checked(await runOnce(run, options));
    expect(first.actors.map(actor => actor.value)).toEqual([[1, 2], [1, 2]]);
    expect(shape(first).toSorted()).toEqual(['alice:flush:0', 'alice:flush:2s', 'bob:flush:0', 'bob:flush:2s']);
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);

  test('a fetch that waits on another actor\'s row lock is observed as a lock wait inside the open cycle', async () => {
    const run = scenario('cursor lock wait', {
      alice: context => withClient(context, async client => {
        await client.query('BEGIN');
        const cursor = client.query(new Cursor<{ value: number }>('SELECT value FROM items WHERE id >= 4 ORDER BY id FOR UPDATE'));
        const values = (await cursor.read(5)).map(row => row.value);
        await cursor.close(); await client.query('COMMIT');
        return values;
      }),
      bob: context => withClient(context, async client => {
        await client.query('BEGIN'); await client.query('UPDATE items SET value = 50 WHERE id = 5'); await client.query('COMMIT');
      }),
    });
    const first = checked(await runOnce(run, { ...options, plan: ['bob', 'bob', 'alice', 'alice', 'alice', 'bob'] }));
    expect(shape(first)).toEqual(['bob:complete', 'bob:complete', 'alice:complete', 'alice:flush:0', 'alice:flush:2', 'bob:complete', 'alice:sync', 'alice:complete']);
    const waiting = first.trace[4]!;
    expect(waiting.waits.length).toBeGreaterThan(0);
    expect(waiting.waits[0]!.blockerPids).toEqual([first.trace[0]!.backendPid]);
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toEqual([4, 50]);
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);

  test('pg-query-stream and Postgres.js cursors stream through Flush stages and replay', async () => {
    const run = scenario('cursor streams', {
      alice: context => withClient(context, async client => {
        const values: number[] = [];
        for await (const row of client.query(new QueryStream('SELECT value FROM items ORDER BY id', [], { batchSize: 2 }))) values.push((row as { value: number }).value);
        return values;
      }),
      bob: async ({ connectionString, signal }) => {
        const sql = postgres(connectionString, { max: 1, ssl: false, fetch_types: false });
        const abort = () => { void sql.end({ timeout: 0 }); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          const batches: number[][] = [];
          for await (const rows of sql<{ value: number }[]>`SELECT value FROM items WHERE id > ${1} ORDER BY id`.cursor(3)) batches.push(rows.map(row => row.value));
          for await (const rows of sql<{ id: number }[]>`SELECT id FROM items ORDER BY id`.cursor(2)) { batches.push(rows.map(row => row.id)); break; }
          return batches;
        } finally { signal.removeEventListener('abort', abort); await sql.end({ timeout: 1 }); }
      },
    });
    const first = checked(await runOnce(run, options));
    expect(first.actors.map(actor => actor.value)).toEqual([[1, 2, 3, 4, 5], [[2, 3, 4], [5], [1, 2]]]);
    const stages = (actor: string) => first.trace.filter(step => step.actor === actor).map(step => step.stage);
    expect(stages('alice')).toEqual(['flush', 'flush', 'flush', 'flush', 'sync']);
    // Postgres.js describes the parameterized statement before binding it.
    expect(stages('bob')).toEqual(['describe', 'flush', 'flush', 'sync', 'flush', 'sync']);
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);
});
