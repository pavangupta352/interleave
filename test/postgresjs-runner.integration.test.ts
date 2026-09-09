import assert from 'node:assert/strict';
import postgres from 'postgres';
import { afterEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import { minimize } from '../src/minimize.js';
import type { ActorContext, RunResult, Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const options = { databaseUrl, protocolProfile: 'describe-flush-v1' as const };
const ownedNames = new Set<string>();
afterEach(async () => {
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  try {
    const leftovers = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [[...ownedNames]])).rows;
    // Exact captured ownership also permits cleanup when a regression interrupts a test.
    for (const { datname } of leftovers) { assert.match(datname, /^interleave_[0-9a-f]{32}$/); await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`); }
    expect(leftovers).toEqual([]);
  } finally { ownedNames.clear(); await admin.end(); }
});
function checked(run: RunResult, outcome: RunResult['outcome'] = 'passed') {
  expect(run.outcome, run.reason).toBe(outcome); expect(run.cleanup.complete).toBe(true); expect(run.schemaVersion).toBe(2);
  expect(parseRunArtifact(run)).toEqual(run); return run;
}
async function withDriver<T>({ connectionString, signal }: ActorContext, body: (sql: postgres.Sql) => Promise<T>, prepare = true, fetchTypes = false): Promise<T> {
  const sql = postgres(connectionString, { max: 1, ssl: false, prepare, fetch_types: fetchTypes });
  const abort = () => { void sql.end({ timeout: 0 }); };
  signal.addEventListener('abort', abort, { once: true });
  try { return await body(sql); }
  finally { signal.removeEventListener('abort', abort); await sql.end({ timeout: 1 }); }
}
function base(actors: Scenario['actors'], invariant: Scenario['invariant'] = async () => {}): Scenario {
  return { name: 'pinned Postgres.js staged runner',
    async setup({ db, connectionString }) {
      ownedNames.add(new URL(connectionString).pathname.slice(1));
      await db.query('CREATE TABLE effects (id integer PRIMARY KEY, value integer); INSERT INTO effects VALUES (1, 0)');
    }, actors: { ...actors, async idle() {} }, invariant };
}

describe('actual Postgres.js 3.4.9 through the staged runner', () => {
  test.each([true, false])('replays across fresh relation OIDs with actual type discovery and prepared reuse (prepare %s)', async prepare => {
    const oids: number[] = [];
    const scenario = base({ reader: context => withDriver(context, async sql => {
      const query = (id: number) => sql`SELECT value FROM effects WHERE id=${id}`;
      return [[...await query(1)], [...await query(2)], [...await query(1)]];
    }, prepare, true) });
    const setup = scenario.setup;
    scenario.setup = async context => { await setup(context); oids.push(Number((await context.db.query("SELECT 'effects'::regclass::oid AS oid")).rows[0].oid)); };
    const first = checked(await runOnce(scenario, options));
    const selected = first.trace.filter(step => step.sql === 'SELECT value FROM effects WHERE id=$1');
    expect(selected.map(step => step.stage)).toEqual(prepare ? ['describe', 'execute', 'complete', 'complete'] : ['describe', 'execute', 'describe', 'execute', 'describe', 'execute']);
    expect(first.trace[0]!.sql).toContain('pg_catalog.pg_type');
    expect(selected[0]!.completion).toEqual({ kind: 'metadata', result: 'described', parameterCount: 1, columnCount: 1, resultShape: 'rows' });
    const repeated = checked(await replay(scenario, first, { databaseUrl }));
    expect(oids).toHaveLength(2); expect(oids[0]).not.toBe(oids[1]);
    expect(repeated.environment.fixture).toEqual(first.environment.fixture);
    expect(repeated.trace.map(step => step.fingerprint)).toEqual(first.trace.map(step => step.fingerprint));
    expect(repeated.actors.find(actor => actor.actor === 'reader')!.value).toEqual([[{ value: 0 }], [], [{ value: 0 }]]);
  });

  test.each(['sql', 'parameter'] as const)('rejects changed %s before its corresponding release gate and permits an explicit guided run', async change => {
    let value = 41, statement = 'UPDATE effects SET value=$1 WHERE id=1 RETURNING value';
    const scenario = base({ writer: context => withDriver(context, async sql => [...await sql.unsafe(statement, [value])]) });
    const first = checked(await runOnce(scenario, options));
    expect(first.trace.map(step => step.stage)).toEqual(['describe', 'execute']);
    if (change === 'sql') statement = 'UPDATE effects SET value=$1+1 WHERE id=1 RETURNING value'; else value = 42;
    const drift = checked(await replay(scenario, first, { databaseUrl }), 'incompatible');
    expect(drift.trace.map(step => step.stage)).toEqual(change === 'sql' ? [] : ['describe']);
    expect(drift.reason).toMatch(/query.*identity changed/);
    const guided = checked(await replay(scenario, first, { databaseUrl, mode: 'guided' }));
    expect(guided.actors.find(actor => actor.actor === 'writer')!.value).toEqual([{ value: 42 }]);
  });

  test.each([true, false])('records Parse error recovery, transaction rollback, and subsequent execution (prepare %s)', async prepare => {
    const scenario = base({ writer: context => withDriver(context, async sql => {
      await sql.begin(async tx => { await tx`UPDATE effects SET value=${41} WHERE id=1`; });
      await assert.rejects(sql.begin(async tx => { await tx`UPDAT effects SET value=${99} WHERE id=1`; }), { code: '42601' });
      await assert.rejects(sql.begin(async tx => { await tx`INSERT INTO effects VALUES (${1}, ${99})`; }), { code: '23505' });
      return [...await sql`SELECT value FROM effects WHERE id=${1}`];
    }, prepare) }, async ({ db }) => { assert.equal((await db.query('SELECT value FROM effects')).rows[0].value, 41); });
    const first = checked(await runOnce(scenario, options));
    const recovery = first.trace.find(step => step.stage === 'recover')!;
    expect(recovery.completion).toEqual({ kind: 'ready', transactionStatus: 'E', commandTags: [], rowCount: 0, error: { code: '42601', message: 'syntax error at or near "UPDAT"' } });
    const prefix = first.trace.find(step => step.actor === recovery.actor && step.ordinal === recovery.prefixOrdinal)!;
    expect(prefix.completion).toMatchObject({ kind: 'metadata', result: 'error', error: { code: '42601' } });
    expect(first.trace.some(step => step.sql === 'rollback' && step.completion?.transactionStatus === 'I')).toBe(true);
    checked(await replay(scenario, first, { databaseUrl }));
  });

  test.each(['describe', 'execute'] as const)('records and replays a genuine lock wait in the %s stage', async stage => {
    const scenario = base({
      locker: context => withDriver(context, async sql => {
        await sql.unsafe('BEGIN').simple();
        await sql.unsafe(stage === 'describe' ? 'LOCK TABLE effects IN ACCESS EXCLUSIVE MODE' : 'UPDATE effects SET value=41 WHERE id=1').simple();
        await sql.unsafe('COMMIT').simple();
      }),
      reader: context => withDriver(context, async sql => [...await sql.unsafe(`SELECT value FROM effects WHERE id=$1${stage === 'execute' ? ' FOR UPDATE' : ''}`, [1])]),
    });
    const plan = stage === 'describe' ? ['locker', 'locker', 'reader', 'locker', 'reader'] : ['locker', 'locker', 'reader', 'reader', 'locker'];
    const first = checked(await runOnce(scenario, { ...options, plan }));
    const waiting = first.trace.find(step => step.actor === 'reader' && step.stage === stage)!;
    expect(waiting.waits[0]).toMatchObject({ waitEventType: 'Lock', blockerPids: [first.trace[0]!.backendPid] });
    expect(waiting.completedAt).toBeTypeOf('number');
    const reader = first.trace.filter(step => step.actor === 'reader'); expect(reader[0]!.backendPid).toBe(reader[1]!.backendPid);
    checked(await replay(scenario, first, { databaseUrl }));
  });

  test('bounds execution after metadata without forwarding the continuation', async () => {
    const scenario = base({ writer: context => withDriver(context, async sql => [...await sql`UPDATE effects SET value=${41} WHERE id=1 RETURNING value`]) });
    const run = checked(await runOnce(scenario, { ...options, maxSteps: 1 }), 'inconclusive');
    expect(run.reason).toMatch(/1-step limit/); expect(run.trace.map(step => step.stage)).toEqual(['describe']);
    expect(run.trace[0]!.completion).toMatchObject({ kind: 'metadata', result: 'described' });
  });

  test('reduces schedule choices while preserving the observed invariant failure and staged profile', async () => {
    const increment: Scenario['actors'][string] = context => withDriver(context, async sql => {
      const row = (await sql`SELECT value FROM effects WHERE id=${1}`)[0]!;
      await sql`UPDATE effects SET value=${Number(row.value) + 1} WHERE id=1`;
    });
    const scenario = base({ alice: increment, bob: increment }, async ({ db }) => {
      assert.equal((await db.query('SELECT value FROM effects')).rows[0].value, 2, 'both real increments must remain');
    });
    const first = checked(await runOnce(scenario, options), 'violation');
    const reduced = await minimize(scenario, first, { databaseUrl, maxAttempts: 5 });
    checked(reduced.run, 'violation'); expect(reduced.run.failure!.fingerprint).toBe(first.failure!.fingerprint);
    expect(reduced.run.limits.protocolProfile).toBe('describe-flush-v1'); expect(reduced.attempts).toBeGreaterThan(1);
    expect(reduced.reducedChoices).toBeLessThan(reduced.originalChoices);
  });
});
