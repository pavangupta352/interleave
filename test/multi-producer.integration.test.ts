import assert from 'node:assert/strict';
import { Client } from 'pg';
import postgres from 'postgres';
import { describe, expect, test } from 'vitest';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import { minimize } from '../src/minimize.js';
import { explore } from '../src/explore.js';
import { parseRunArtifact } from '../src/artifact.js';
import type { ActorContext, DatabaseContext, RunResult, Scenario } from '../src/types.js';
import { checkoutTasks, kyselySideQuery, ownLaneLock, poolLostUpdate, withPool } from './fixtures/multi-producer.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const multi = { databaseUrl, connectionProfile: 'multi-producer-v1' as const };
const identities = (run: RunResult) => run.trace.map(step => [step.actor, step.ordinal, step.sql, step.fingerprint]);

describe('multi-producer actors against real PostgreSQL', () => {
  test('records a pooled lost update, replays it exactly and reduces its lane choices', async () => {
    const scenario = poolLostUpdate();
    const first = await runOnce(scenario, { ...multi, plan: ['alice#0', 'alice#1', 'bob', 'alice#0', 'alice#1', 'bob'] });
    expect(first.outcome, first.reason).toBe('violation');
    expect(first.schemaVersion).toBe(4);
    expect(first.limits).toMatchObject({ connectionProfile: 'multi-producer-v1', maxConnectionsPerActor: 8, protocolProfile: 'sync-cycle-v1' });
    expect(first.trace.map(step => `${step.actor}#${step.connection}`)).toEqual(['alice#0', 'alice#1', 'bob#0', 'alice#0', 'alice#1', 'bob#0']);
    expect(first.trace.map(step => step.completion?.rowCount)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(first.actors.map(actor => actor.value)).toEqual([[0, 0], 0]);
    expect(first.connections?.map(item => `${item.actor}#${item.connection}`)).toEqual(expect.arrayContaining(['alice#0', 'alice#1', 'bob#0']));
    expect(first.trace.every(step => step.available.every(entry => /^[a-z]+#\d+$/.test(entry)))).toBe(true);
    expect(parseRunArtifact(JSON.parse(JSON.stringify(first)))).toEqual(first);
    for (let attempt = 0; attempt < 2; attempt++) {
      const repeated = await replay(scenario, parseRunArtifact(JSON.stringify(first)), { databaseUrl });
      expect(repeated.outcome, repeated.reason).toBe('violation');
      expect(repeated.failure).toEqual(first.failure);
      expect(repeated.limits.connectionProfile).toBe('multi-producer-v1');
      expect(identities(repeated)).toEqual(identities(first));
      expect(repeated.cleanup.complete).toBe(true);
    }
    const reduced = await minimize(scenario, first, { databaseUrl, maxAttempts: 16 });
    expect(reduced.run.outcome, reduced.run.reason).toBe('violation');
    expect(reduced.run.failure?.fingerprint).toBe(first.failure?.fingerprint);
    expect(reduced.reducedChoices).toBeLessThan(reduced.originalChoices);
    expect(reduced.run.limits.connectionProfile).toBe('multi-producer-v1');
    expect(parseRunArtifact(reduced.run)).toEqual(reduced.run);
  });

  test('exact replay binds connections by command identity when accept order is reversed', async () => {
    const control = { delayFirstConnect: false };
    const scenario = checkoutTasks(control);
    const plan = ['alice#0', 'alice#1', 'bob', 'alice#1', 'alice#0'];
    const first = await runOnce(scenario, { ...multi, plan });
    expect(first.outcome, first.reason).toBe('passed');
    const lanes = (run: RunResult) => new Map((run.actors[0]!.value as { id: number; pid: number }[])
      .map(task => [task.id, run.trace.find(step => step.backendPid === task.pid)!.connection]));
    expect(lanes(first)).toEqual(new Map([[1, 0], [2, 1]]));
    control.delayFirstConnect = true;
    const reversed = await replay(scenario, first, { databaseUrl });
    expect(reversed.outcome, reversed.reason).toBe('passed');
    // The same logical tasks now arrived in the opposite order.
    expect(lanes(reversed)).toEqual(new Map([[1, 1], [2, 0]]));
    expect(identities(reversed)).toEqual(identities(first));
    expect(reversed.trace.filter(step => step.actor === 'alice').map(step => step.connection))
      .toEqual(first.trace.filter(step => step.actor === 'alice').map(step => 1 - step.connection));
    control.delayFirstConnect = false;
    const changed = await replay(checkoutTasks({ delayFirstConnect: true, changed: true }), first, { databaseUrl });
    expect(changed.outcome).toBe('incompatible');
    expect(changed.reason).toMatch(/identity changed/);
    expect(changed.durationMs).toBeLessThan(first.limits.timeoutMs);
  });

  test('observes and replays a lock wait between two connections of one actor', async () => {
    const scenario = ownLaneLock();
    const plan = ['alice#0', 'alice#0', 'alice#1', 'alice#0', 'bob'];
    const first = await runOnce(scenario, { ...multi, plan });
    expect(first.outcome, first.reason).toBe('passed');
    const waiting = first.trace[2]!;
    expect(waiting).toMatchObject({ actor: 'alice', connection: 1 });
    expect(waiting.sql).toContain('value + 10');
    expect(waiting.waits[0]?.waitEventType).toBe('Lock');
    expect(waiting.waits[0]?.blockerPids).toEqual([first.trace[0]!.backendPid]);
    // The commit on the blocking connection was released while the other connection waited.
    expect(first.trace[3]!.releasedAt).toBeLessThan(waiting.completedAt!);
    const repeated = await replay(scenario, first, { databaseUrl });
    expect(repeated.outcome, repeated.reason).toBe('passed');
    expect(repeated.trace[2]!.waits[0]?.blockerPids).toEqual([repeated.trace[0]!.backendPid]);
    const altered = structuredClone(first);
    altered.trace[2]!.waits = [];
    const mismatch = await replay(scenario, altered, { databaseUrl });
    expect(mismatch.outcome).toBe('incompatible');
    expect(mismatch.reason).toMatch(/lock-wait/);
  });

  test('a connection waiting on a session outside the scheduled actors is inconclusive', async () => {
    let direct: DatabaseContext['connectionOptions'] | undefined;
    let outside: Client | undefined;
    let lockTaken!: () => void;
    const locked = new Promise<void>(resolve => { lockTaken = resolve; });
    const scenario: Scenario = {
      name: 'pool-outside-lock',
      async setup(context) {
        await context.db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1, 0)');
        direct = context.connectionOptions;
      },
      actors: {
        alice: context => withPool(context, async pool => {
          await locked;
          const client = await pool.connect();
          try { await client.query('BEGIN'); await client.query('UPDATE counter SET value = 1 WHERE id = 1'); await client.query('COMMIT'); }
          finally { client.release(); }
        }),
        // An unscheduled direct session: it bypasses the actor endpoint entirely.
        async bob() {
          outside = new Client(direct!);
          outside.on('error', () => undefined);
          await outside.connect();
          await outside.query('BEGIN; SELECT value FROM counter WHERE id = 1 FOR UPDATE');
          lockTaken();
        },
      },
      async invariant() {},
    };
    try {
      const result = await runOnce(scenario, { ...multi, plan: ['alice#0', 'alice#0'] });
      expect(result.outcome, result.reason).toBe('inconclusive');
      expect(result.reason).toMatch(/alice#0 is waiting for a lock outside the scheduled actors/);
      expect(result.trace.map(step => step.sql)).toEqual(['BEGIN', 'UPDATE counter SET value = 1 WHERE id = 1']);
      expect(result.cleanup.complete).toBe(true);
    } finally { await outside?.end().catch(() => undefined); }
  });

  test('a Kysely transaction with a side query on the pool records a real double redemption', async () => {
    const scenario = kyselySideQuery();
    const first = await runOnce(scenario, { ...multi, plan: ['alice#0', 'bob#0', 'alice#1', 'bob#1'] });
    expect(first.outcome, first.reason).toBe('violation');
    expect(first.failure?.message).toMatch(/redeemed 2 times/);
    const side = first.trace.filter(step => step.connection === 1);
    expect(side.map(step => step.actor)).toEqual(['alice', 'bob']);
    expect(side.every(step => /from "coupons"/.test(step.sql) && step.completion?.transactionStatus === 'I')).toBe(true);
    expect(first.trace.some(step => step.waits.length > 0)).toBe(true);
    const repeated = await replay(scenario, first, { databaseUrl });
    expect(repeated.outcome, repeated.reason).toBe('violation');
    expect(identities(repeated)).toEqual(identities(first));
    // Actor-level choices use whichever connection of that actor can proceed.
    const serial = await runOnce(scenario, { ...multi, plan: ['alice', 'alice', 'alice', 'alice', 'alice'] });
    expect(serial.outcome, serial.reason).toBe('passed');
    expect(serial.trace.slice(0, 5).map(step => `${step.actor}#${step.connection}`)).toEqual(['alice#0', 'alice#1', 'alice#0', 'alice#0', 'alice#0']);
  });

  test('exploration derives lane-qualified alternatives and finds the pooled lost update', async () => {
    const serial = ['alice#0', 'alice#0', 'alice#1', 'alice#1', 'bob', 'bob'];
    const search = await explore(poolLostUpdate(), { ...multi, maxRuns: 20, plan: serial });
    expect(search.runs[0]?.outcome, search.runs[0]?.reason).toBe('passed');
    expect(search.firstFailure?.outcome, JSON.stringify(search.runs.map(run => [run.outcome, run.reason, run.plan]))).toBe('violation');
    expect(search.runs.slice(1).some(run => run.plan.some(entry => /^alice#\d$/.test(entry)))).toBe(true);
    const exact = await replay(poolLostUpdate(), search.firstFailure!, { databaseUrl });
    expect(exact.outcome, exact.reason).toBe('violation');
  });

  test('Postgres.js with two pooled connections keeps staged cycles open on both lanes and replays exactly', async () => {
    const withSql = async <T>(context: ActorContext, body: (sql: postgres.Sql) => Promise<T>, max: number): Promise<T> => {
      const sql = postgres(context.connectionString, { max, ssl: false, fetch_types: false });
      const abort = (): void => { void sql.end({ timeout: 0 }); };
      context.signal.addEventListener('abort', abort, { once: true });
      try { return await body(sql); } finally { context.signal.removeEventListener('abort', abort); await sql.end({ timeout: 1 }); }
    };
    const increment = async (sql: postgres.Sql): Promise<number> => {
      const [before] = await sql`SELECT value FROM counter WHERE id=${1}`;
      await sql`UPDATE counter SET value=${before!.value + 1} WHERE id=1`;
      return before!.value as number;
    };
    const scenario: Scenario = {
      name: 'postgresjs-pooled-lanes',
      async setup({ db }) { await db.query('CREATE TABLE counter (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO counter VALUES (1, 0)'); },
      actors: {
        alice: context => withSql(context, sql => Promise.all([increment(sql), increment(sql)]), 2),
        bob: context => withSql(context, increment, 1),
      },
      async invariant({ db }) {
        assert.equal((await db.query('SELECT value FROM counter WHERE id=1')).rows[0].value, 3, 'Every Postgres.js increment must be retained');
      },
    };
    const options = { ...multi, protocolProfile: 'describe-flush-v1' as const };
    const first = await runOnce(scenario, { ...options, plan: ['alice#0', 'alice#1', 'bob'] });
    expect(first.outcome, first.reason).toBe('violation');
    expect(first.schemaVersion).toBe(4);
    expect(first.trace.slice(0, 2).map(step => [`${step.actor}#${step.connection}`, step.stage])).toEqual([['alice#0', 'describe'], ['alice#1', 'describe']]);
    expect(new Set(first.trace.filter(step => step.actor === 'alice').map(step => step.connection))).toEqual(new Set([0, 1]));
    expect(first.trace.every(step => step.completion !== undefined)).toBe(true);
    expect(parseRunArtifact(JSON.parse(JSON.stringify(first)))).toEqual(first);
    for (let attempt = 0; attempt < 2; attempt++) {
      const repeated = await replay(scenario, first, { databaseUrl });
      expect(repeated.outcome, repeated.reason).toBe('violation');
      expect(repeated.trace.map(step => [step.stage, step.fingerprint])).toEqual(first.trace.map(step => [step.stage, step.fingerprint]));
    }
  });

  test('the default profile still rejects a second command-producing connection', async () => {
    const result = await runOnce(poolLostUpdate(), { databaseUrl, maxConnectionsPerActor: 2 });
    expect(result.schemaVersion).toBe(3);
    expect(result.limits).not.toHaveProperty('connectionProfile');
    expect(result.outcome).toBe('inconclusive');
    expect(result.reason).toMatch(/one live command-producing connection per actor/);
    await expect(runOnce(poolLostUpdate(), { databaseUrl, plan: ['alice#0'] })).rejects.toThrow(/multi-producer-v1/);
  });

  test('a lane plan waits for a connection and never turns an unavailable lane into a pass', async () => {
    // Nothing else may proceed while the plan waits, so the wait is bounded by half the deadline.
    const waiting = await runOnce(poolLostUpdate(), { ...multi, plan: ['alice#5'], timeoutMs: 1500 });
    expect(waiting.outcome).toBe('incompatible');
    expect(waiting.reason).toMatch(/Schedule asks for alice#5 at step 0, which has not queued its next command; nothing else could proceed for 750 ms/);
    expect(waiting.durationMs).toBeLessThan(1500);
    const settled: Scenario = { ...poolLostUpdate(), actors: {
      alice: context => withPool(context, async pool => (await pool.query('SELECT 1')).rowCount),
      bob: poolLostUpdate().actors.bob!,
    } };
    const infeasible = await runOnce(settled, { ...multi, plan: ['alice', 'bob', 'alice#1'] });
    expect(infeasible.outcome).toBe('incompatible');
    expect(infeasible.reason).toMatch(/Schedule asks for alice#1, which cannot issue its next query at step 2/);
  });

  test('a plan that waits on a connection blocked by held work is infeasible, and reduction continues past it', async () => {
    const scenario = kyselySideQuery();
    // alice#0's next command needs the result of its side query on alice#1, which the plan holds.
    const stuck = await runOnce(scenario, { ...multi, plan: ['alice#0', 'alice#0'], timeoutMs: 4000 });
    expect(stuck.outcome, stuck.reason).toBe('incompatible');
    expect(stuck.reason).toMatch(/Schedule asks for alice#0 at step 1, which has not queued its next command; nothing else could proceed for 2000 ms/);
    expect(stuck.durationMs).toBeLessThan(4000);
    const first = await runOnce(scenario, { ...multi, plan: ['alice#0', 'bob#0', 'alice#1', 'bob#1'] });
    expect(first.outcome, first.reason).toBe('violation');
    const reduced = await minimize(scenario, first, { databaseUrl, maxAttempts: 30, timeoutMs: 4000 });
    expect(reduced.stopReason, reduced.reason).not.toBe('inconclusive');
    expect(reduced.run.outcome).toBe('violation');
    expect(reduced.reducedChoices).toBeLessThan(reduced.originalChoices);
  }, 240_000);

  test('a connection that just completed can queue its next command before the next decision', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = await runOnce(checkoutTasks({ delayFirstConnect: false }), { ...multi, plan: ['alice#0', 'bob'] });
      expect(run.outcome, run.reason).toBe('passed');
      expect(run.trace[0]!.sql).toMatch(/^SELECT value/);
      // alice#0's UPDATE follows its SELECT within milliseconds; the decision includes it.
      expect(run.trace[1]!.available).toContain('alice#0');
    }
  });
});
