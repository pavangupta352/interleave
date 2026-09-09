import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { Client } from 'pg';
import postgres from 'postgres';
import { afterEach, describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { replay } from '../src/replay.js';
import { runOnce } from '../src/runner.js';
import type { ActorContext, RunResult, Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const options = { databaseUrl, protocolProfile: 'describe-flush-v1' as const };
const ownedNames = new Set<string>();

async function journal(record: object) {
  const path = process.env.INTERLEAVE_TEST_DATABASE_JOURNAL;
  if (path) await appendFile(path, `${JSON.stringify(record)}\n`);
}

async function ownDatabase(connectionString: string) {
  const name = new URL(connectionString).pathname.slice(1);
  assert.match(name, /^interleave_[0-9a-f]{32}$/);
  ownedNames.add(name);
  await journal({ event: 'setup', name });
}

afterEach(async () => {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const names = [...ownedNames];
    const query = 'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])';
    const leftovers = (await admin.query(query, [names])).rows;
    // Clean only captured task-owned databases, while still failing on a leaked run.
    for (const { datname } of leftovers) {
      assert.match(datname, /^interleave_[0-9a-f]{32}$/);
      await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
    }
    const remaining = (await admin.query(query, [names])).rows;
    await journal({ event: 'independent-cleanup-check', names, leftovers, remaining });
    expect(remaining).toEqual([]);
    expect(leftovers).toEqual([]);
  } finally {
    ownedNames.clear();
    await admin.end();
  }
});

async function withDriver<T>(context: ActorContext, prepare: boolean, body: (sql: postgres.Sql) => Promise<T>, commands?: Record<string, string[]>): Promise<T> {
  const sql = postgres(context.connectionString, {
    max: 1, ssl: false, prepare, fetch_types: false,
    // Public diagnostics retain attempted commands, including a command rejected before release.
    debug: commands ? (_connection, query) => {
      assert(commands[context.actor]!.length < 32, 'Bounded deadlock command diagnostics');
      commands[context.actor]!.push(query);
    } : false,
  });
  const abort = () => { void sql.end({ timeout: 0 }); };
  context.signal.addEventListener('abort', abort, { once: true });
  if (context.signal.aborted) abort();
  try { return await body(sql); }
  finally {
    context.signal.removeEventListener('abort', abort);
    await sql.end({ timeout: 1 });
  }
}

function checkConflict(run: RunResult, code: '40P01' | '40001', outcome: 'passed' | 'actor-error') {
  expect(run.outcome, run.reason).toBe(outcome);
  expect(run.cleanup.complete).toBe(true);
  expect(run.failure).toBeUndefined();
  expect(run.schemaVersion).toBe(2);
  expect(parseRunArtifact(run)).toEqual(run);
  expect(run.trace.every(step => step.completion !== undefined)).toBe(true);
  const errors = run.trace.filter(step => step.completion?.error !== undefined);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.completion).toMatchObject({ kind: 'ready', transactionStatus: 'E', error: { code } });
  expect(errors[0]!.waits.some(wait => wait.waitEventType === 'Lock')).toBe(true);
  const failedActor = errors[0]!.actor;
  const rollbacks = run.trace.filter(step => step.sql === 'rollback');
  expect(rollbacks).toHaveLength(1);
  expect(rollbacks[0]).toMatchObject({ actor: failedActor, completion: { kind: 'ready', transactionStatus: 'I', commandTags: ['ROLLBACK'] } });
  expect(rollbacks[0]!.ordinal).toBeGreaterThan(errors[0]!.ordinal);
  // A successful real query on the failed actor follows the driver's automatic rollback.
  expect(run.trace.find(step => step.actor === failedActor && step.sql === 'SELECT $1::integer AS subsequent' && step.stage !== 'describe'))
    .toMatchObject({ completion: { kind: 'ready', transactionStatus: 'I', rowCount: 1 } });
  expect(run.connections?.map(connection => connection.actor).sort()).toEqual(['alice', 'bob']);
  return failedActor;
}

function identities(run: RunResult) {
  return run.trace.map(({ index, actor, connection, ordinal, protocol, sql, fingerprint, stage, cycle, prefixOrdinal }) =>
    ({ index, actor, connection, ordinal, protocol, sql, fingerprint, stage, cycle, prefixOrdinal }));
}

async function checkReplays(scenario: Scenario, recorded: RunResult, check: (run: RunResult) => void) {
  await journal({ event: 'recording', run: recorded });
  check(recorded);
  for (let attempt = 0; attempt < 2; attempt++) {
    const repeated = await replay(scenario, recorded, { databaseUrl });
    await journal({ event: 'exact-replay', run: repeated });
    check(repeated);
    expect(repeated.environment.fixture).toEqual(recorded.environment.fixture);
    expect(identities(repeated)).toEqual(identities(recorded));
    expect(repeated.actors).toEqual(recorded.actors);
  }
}

function deadlockScenario(prepare: boolean, handled: boolean, commands: Record<string, string[]>): Scenario {
  const update = (first: number, second: number): Scenario['actors'][string] => context => withDriver(context, prepare, async sql => {
    try {
      await sql.begin(async tx => {
        await tx`UPDATE accounts SET value = value + 1 WHERE id = ${first}`;
        await tx`UPDATE accounts SET value = value + 1 WHERE id = ${second}`;
      });
      return { committed: true, values: (await sql`SELECT value FROM accounts ORDER BY id`).map(row => row.value) };
    } catch (error) {
      assert(error instanceof postgres.PostgresError);
      assert.equal(error.code, '40P01');
      const rows = await sql`SELECT ${42}::integer AS subsequent`;
      assert.equal(rows[0]!.subsequent, 42);
      if (!handled) throw error;
      return { committed: false, code: error.code, subsequent: rows[0]!.subsequent };
    }
  }, commands);
  return {
    name: 'Postgres.js public transaction deadlock',
    async setup({ db, connectionString }) {
      commands.alice = []; commands.bob = [];
      await ownDatabase(connectionString);
      await db.query('CREATE TABLE accounts (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO accounts VALUES (1,0),(2,0)');
    },
    actors: { alice: update(1, 2), bob: update(2, 1) },
    async invariant({ db, results }) {
      assert.equal(handled, true, 'An unhandled database error must skip the invariant');
      assert.deepEqual((await db.query('SELECT value FROM accounts ORDER BY id')).rows, [{ value: 1 }, { value: 1 }]);
      assert.equal(results.filter(result => (result.value as { committed: boolean }).committed).length, 1);
    },
  };
}

function serializableScenario(prepare: boolean, retry: boolean): Scenario {
  const increment: Scenario['actors'][string] = context => withDriver(context, prepare, async sql => {
    const reads: number[] = [];
    const errors: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await sql.begin('isolation level serializable', async tx => {
          await tx`UPDATE attempts SET commits = commits + 1 WHERE actor = ${context.actor}`;
          const rows = await tx`SELECT value FROM counter WHERE id = ${1}`;
          const value = Number(rows[0]!.value);
          reads.push(value);
          await tx`UPDATE counter SET value = ${value + 1} WHERE id = ${1}`;
        });
        return { attempts: attempt, reads, errors };
      } catch (error) {
        assert(error instanceof postgres.PostgresError);
        assert.equal(error.code, '40001');
        errors.push(error.code);
        assert.equal((await sql`SELECT ${42}::integer AS subsequent`)[0]!.subsequent, 42);
        // A write made before the failing counter UPDATE must have rolled back too.
        assert.equal((await sql`SELECT commits FROM attempts WHERE actor = ${context.actor}`)[0]!.commits, 0);
        if (!retry || attempt === 2) throw error;
      }
    }
    throw new Error('Whole-transaction retry exhausted');
  });
  return {
    name: 'Postgres.js public serializable transaction retry',
    async setup({ db, connectionString }) {
      await ownDatabase(connectionString);
      await db.query("CREATE TABLE counter (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO counter VALUES (1,0); CREATE TABLE attempts (actor text PRIMARY KEY, commits integer NOT NULL); INSERT INTO attempts VALUES ('alice',0),('bob',0)");
    },
    actors: { alice: increment, bob: increment },
    async invariant({ db, results }) {
      assert.equal(retry, true, 'An unhandled database error must skip the invariant');
      assert.equal((await db.query('SELECT value FROM counter')).rows[0].value, 2);
      assert.deepEqual((await db.query('SELECT actor, commits FROM attempts ORDER BY actor')).rows, [{ actor: 'alice', commits: 1 }, { actor: 'bob', commits: 1 }]);
      assert.deepEqual(results.map(result => (result.value as { attempts: number }).attempts).sort(), [1, 2]);
    },
  };
}

describe.each([true, false])('Postgres.js 3.4.9 real transaction conflicts, prepare=%s', prepare => {
  test.each([true, false])('preserves 40P01 rollback and replay or proven victim divergence, handled=%s', async handled => {
    const commands: Record<string, string[]> = {};
    const scenario = deadlockScenario(prepare, handled, commands);
    const plan = ['alice', 'bob', 'alice', 'alice', 'bob', 'bob', 'alice', ...(!prepare ? ['alice'] : []), 'bob', ...(!prepare ? ['bob'] : [])];
    const recorded = await runOnce(scenario, { ...options, plan });
    const check = (run: RunResult) => {
      const failedActor = checkConflict(run, '40P01', handled ? 'passed' : 'actor-error');
      const failed = run.actors.find(actor => actor.actor === failedActor)!;
      expect(failed.status).toBe(handled ? 'fulfilled' : 'rejected');
      if (handled) expect(failed.value).toEqual({ committed: false, code: '40P01', subsequent: 42 });
      expect(run.actors.find(actor => actor.actor !== failedActor)!.value).toEqual({ committed: true, values: [1, 1] });
    };
    await journal({ event: 'deadlock-recording', run: recorded, commands });
    check(recorded);
    for (let attempt = 0; attempt < 2; attempt++) {
      const repeated = await replay(scenario, recorded, { databaseUrl });
      await journal({ event: 'deadlock-exact-replay', run: repeated, commands });
      if (repeated.outcome !== 'incompatible') {
        check(repeated);
        expect(identities(repeated)).toEqual(identities(recorded));
        expect(repeated.actors).toEqual(recorded.actors);
        continue;
      }
      // PostgreSQL chooses the victim. A changed victim is accepted only with
      // actual 40P01 evidence and the opposite attempted COMMIT/ROLLBACK at the gate.
      expect(repeated.cleanup.complete).toBe(true);
      expect(parseRunArtifact(repeated)).toEqual(repeated);
      expect(repeated.environment.fixture).toEqual(recorded.environment.fixture);
      expect(repeated.connections).toEqual(recorded.connections);
      const firstFollowup = recorded.trace.findIndex(step => step.sql === 'commit' || step.sql === 'rollback');
      expect(firstFollowup).toBe(prepare ? 8 : 10);
      const expected = recorded.trace[firstFollowup]!;
      expect(repeated.trace).toHaveLength(firstFollowup);
      expect(identities(repeated)).toEqual(identities(recorded).slice(0, firstFollowup));
      const errors = repeated.trace.filter(step => step.completion?.error);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.completion).toMatchObject({ kind: 'ready', transactionStatus: 'E', error: { code: '40P01' } });
      expect(errors[0]!.actor).not.toBe(recorded.trace.find(step => step.completion?.error?.code === '40P01')!.actor);
      const actual = commands[expected.actor]!.filter(sql => sql === 'commit' || sql === 'rollback');
      expect(actual).toEqual([expected.sql === 'commit' ? 'rollback' : 'commit']);
      expect(repeated.reason).toBe(`Replay query or actor startup identity changed for ${expected.actor} at step ${firstFollowup}`);
    }
  });

  test.each([true, false])('replays 40001 and automatic rollback, whole-transaction retry=%s', async retry => {
    const scenario = serializableScenario(prepare, retry);
    const plan = ['alice', 'bob', 'alice', 'alice', 'bob', 'bob', 'alice', 'alice', 'bob', 'bob', 'alice', 'alice', 'bob', 'bob', 'alice'];
    const recorded = await runOnce(scenario, { ...options, plan });
    await checkReplays(scenario, recorded, run => {
      const failedActor = checkConflict(run, '40001', retry ? 'passed' : 'actor-error');
      const failed = run.actors.find(actor => actor.actor === failedActor)!;
      expect(failed.status).toBe(retry ? 'fulfilled' : 'rejected');
      if (retry) {
        expect(failed.value).toEqual({ attempts: 2, reads: [0, 1], errors: ['40001'] });
        const begins = run.trace.filter(step => step.actor === failedActor && step.sql === 'begin isolation level serializable');
        expect(begins).toHaveLength(2);
        expect(begins.every(step => step.completion?.transactionStatus === 'T')).toBe(true);
        const reads = run.trace.filter(step => step.actor === failedActor && step.sql === 'SELECT value FROM counter WHERE id = $1');
        expect(reads.map(step => step.stage)).toEqual(prepare ? ['describe', 'execute', 'complete'] : ['describe', 'execute', 'describe', 'execute']);
      }
      expect(run.actors.find(actor => actor.actor !== failedActor)!.value).toEqual({ attempts: 1, reads: [0], errors: [] });
    });
  });
});
