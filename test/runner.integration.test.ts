import { testDatabaseUrl } from './helpers/postgres.js';
import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import { runOnce, runInOwnedDatabase } from '../src/runner.js';
import { createOwnedDatabase } from '../src/database.js';
import type { Scenario } from '../src/types.js';

const databaseUrl = testDatabaseUrl();

function counterScenario(options: { slow?: boolean; brokenActor?: boolean; locked?: boolean } = {}): Scenario {
  const increment: Scenario['actors'][string] = async ({ connectionString }) => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      if (options.brokenActor) throw new Error('operation failed before querying');
      if (options.locked) await client.query('BEGIN');
      if (options.slow) await client.query('SELECT pg_sleep(0.08)');
      const { rows } = await client.query(`SELECT value FROM counter WHERE id = 1${options.locked ? ' FOR UPDATE' : ''}`);
      await client.query('UPDATE counter SET value = $1 WHERE id = 1', [Number(rows[0].value) + 1]);
      if (options.locked) await client.query('COMMIT');
    } finally { await client.end(); }
  };
  return {
    name: 'counter-increments',
    setup: async ({ db }) => {
      await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1, 0)');
    },
    actors: { alice: increment, bob: increment },
    invariant: async ({ db }) => {
      const { rows } = await db.query('SELECT value FROM counter WHERE id = 1');
      assert.equal(rows[0].value, 2, 'both increments must be retained');
    },
  };
}

describe('runner integration', () => {
  test('releases both real reads before writes and records the lost update', async () => {
    const run = await runOnce(counterScenario(), { databaseUrl, plan: ['alice', 'bob', 'alice', 'bob'] });
    expect(run.outcome).toBe('violation');
    expect(run.trace.map(s => s.actor)).toEqual(['alice', 'bob', 'alice', 'bob']);
    expect(run.trace.map(s => s.completion?.rowCount)).toEqual([1, 1, 1, 1]);
    expect(run.failure?.message).toContain('both increments must be retained');
    expect(run.cleanup.complete).toBe(true);
  });

  test('a serial order preserves both increments in the same application', async () => {
    const run = await runOnce(counterScenario(), { databaseUrl, plan: ['alice', 'alice', 'bob', 'bob'] });
    expect(run.outcome).toBe('passed');
    expect(run.trace).toHaveLength(4);
  });

  test('observes a real row lock and permits its owner to finish', async () => {
    const run = await runOnce(counterScenario({ locked: true }), {
      databaseUrl, plan: ['alice', 'bob', 'alice', 'bob', 'alice', 'alice', 'bob', 'bob'],
    });
    expect(run.outcome).toBe('passed');
    const waiting = run.trace.find(s => s.actor === 'bob' && s.sql.includes('FOR UPDATE'));
    expect(waiting?.waits[0]?.waitEventType).toBe('Lock');
    expect(waiting?.waits[0]?.blockerPids).toContain(run.trace[0]?.backendPid);
    expect(waiting?.completedAt).toBeTypeOf('number');
  });

  test('slow nonblocking work never becomes lock evidence', async () => {
    const run = await runOnce(counterScenario({ slow: true }), { databaseUrl });
    expect(run.trace.filter(s => s.sql.includes('pg_sleep')).every(s => s.waits.length === 0)).toBe(true);
    expect(run.outcome).toBe('violation');
  });

  test('actor failures remain distinct from invariant violations', async () => {
    const run = await runOnce(counterScenario({ brokenActor: true }), { databaseUrl });
    expect(run.outcome).toBe('actor-error');
    expect(run.failure).toBeUndefined();
    expect(run.actors.every(a => a.status === 'rejected')).toBe(true);
  });

  test('step exhaustion is inconclusive and cleans up the disposable database', async () => {
    const run = await runOnce(counterScenario(), { databaseUrl, maxSteps: 1 });
    expect(run.outcome).toBe('inconclusive');
    expect(run.reason).toMatch(/step/i);
    expect(run.cleanup.complete).toBe(true);
  });

  test('exact replay rejects changed SQL rather than reporting a matching pass', async () => {
    const first = await runOnce(counterScenario(), { databaseUrl });
    expect(first.outcome).toBe('violation');
    const changed = counterScenario();
    changed.actors.bob = async ({ connectionString }) => {
      const c = new Client({ connectionString }); await c.connect();
      try { await c.query('UPDATE counter SET value = value + 1 WHERE id = 1'); } finally { await c.end(); }
    };
    const next = await runOnce(changed, { databaseUrl, replay: first });
    expect(next.outcome).toBe('incompatible');
    expect(next.reason).toMatch(/bob|fingerprint|query/i);
  });

  test('exact replay verifies observed wait constraints as well as query order', async () => {
    const original = await runOnce(counterScenario({ locked: true }), {
      databaseUrl, plan: ['alice', 'bob', 'alice', 'bob', 'alice', 'alice', 'bob', 'bob'],
    });
    expect(original.outcome).toBe('passed');
    expect(original.trace.some(step => step.waits.length > 0)).toBe(true);
    const altered = structuredClone(original);
    for (const step of altered.trace) step.waits = [];
    const result = await runOnce(counterScenario({ locked: true }), { databaseUrl, replay: altered });
    expect(result.outcome).toBe('incompatible');
    expect(result.reason).toMatch(/wait/i);
  });

  test('a non-JSON actor observation is a harness error instead of silently losing data', async () => {
    const scenario = counterScenario();
    const previous = scenario.actors.alice!;
    scenario.actors.alice = async context => { await previous(context); return { unavailable: undefined }; };
    const result = await runOnce(scenario, { databaseUrl });
    expect(result.outcome).toBe('harness-error');
    expect(result.reason).toMatch(/JSON/);
  });

  test('a requested plan cannot silently leave unconsumed choices after actors finish', async () => {
    const result = await runOnce(counterScenario(), {
      databaseUrl, plan: ['alice', 'bob', 'alice', 'bob', 'alice'],
    });
    expect(result.outcome).toBe('incompatible');
  });

  test('an undefined rejection never becomes a successful invariant or setup', async () => {
    const input: Scenario = {
      name: 'undefined-rejection', async setup() {},
      actors: { async a() {}, async b() {} }, invariant: () => Promise.reject(undefined),
    };
    expect((await runOnce(input, { databaseUrl })).outcome).toBe('harness-error');
    input.setup = () => Promise.reject(undefined);
    input.invariant = async () => {};
    expect((await runOnce(input, { databaseUrl })).outcome).toBe('harness-error');
  });

  test('invalidates earlier lock observations when a blocker completes during a later sample', async () => {
    const owned = await createOwnedDatabase(databaseUrl);
    let blockerPid = 0;
    let delayed = false;
    const observe = owned.observeWait.bind(owned);
    owned.observeWait = async pid => {
      const sample = await observe(pid);
      if (pid === blockerPid && sample && !delayed) {
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return sample;
    };
    const connect = async (url: string, name: string) => {
      const client = new Client({ connectionString: url, application_name: name });
      client.on('error', () => undefined);
      await client.connect();
      return client;
    };
    const run = await runInOwnedDatabase({
      name: 'lock-observer-epoch',
      async setup({ db }) { await db.query('CREATE TABLE t(id int PRIMARY KEY, v int); INSERT INTO t VALUES(1,0),(2,0)'); },
      actors: {
        async a({ connectionString }) {
          const c = await connect(connectionString, 'observed-a');
          try { await c.query('UPDATE t SET v=v+1 WHERE id=1; SELECT pg_sleep(0.7)'); } finally { await c.end(); }
        },
        async b({ connectionString }) {
          const c = await connect(connectionString, 'observed-b');
          blockerPid = (c as Client & { processID: number }).processID;
          try {
            await c.query("BEGIN; UPDATE t SET v=v+1 WHERE id=1; SET LOCAL lock_timeout='150ms'");
            await c.query('UPDATE t SET v=v+1 WHERE id=2').catch(() => undefined);
            await c.query('ROLLBACK');
          } finally { await c.end(); }
        },
        async c({ connectionString }) {
          const c = await connect(connectionString, 'observer-c');
          try { return (await c.query("SELECT wait_event FROM pg_stat_activity WHERE application_name='observed-a' AND datname=current_database()")).rows; } finally { await c.end(); }
        },
        async d({ connectionString }) {
          const c = await connect(connectionString, 'observed-d');
          try { await c.query('BEGIN; UPDATE t SET v=v+1 WHERE id=2'); await c.query('COMMIT'); } finally { await c.end(); }
        },
      },
      async invariant({ results }) {
        const observations = results.find(result => result.actor === 'c')!.value as { wait_event: string | null }[];
        assert.equal(observations.some(row => row.wait_event === 'PgSleep'), false, 'A must finish its nonblocked work before C is released');
      },
    }, { databaseUrl, plan: ['b', 'd', 'a', 'b', 'c'] }, owned);
    expect(delayed).toBe(true);
    expect(run.outcome).toBe('passed');
  });
});
