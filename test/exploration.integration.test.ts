import { testDatabaseUrl } from './helpers/postgres.js';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import { explore } from '../src/explore.js';
import { replay } from '../src/replay.js';
import { minimize } from '../src/minimize.js';
import { runOnce } from '../src/runner.js';
import { parseRunArtifact } from '../src/artifact.js';
import type { Scenario } from '../src/types.js';

const databaseUrl = testDatabaseUrl();
function race(atomic = false): Scenario {
  const increment: Scenario['actors'][string] = async ({ connectionString }) => {
    const db = new Client({ connectionString });
    db.on('error', () => undefined);
    await db.connect();
    try {
      const { rows } = await db.query('SELECT n FROM counts');
      if (atomic) await db.query('UPDATE counts SET n = n + 1');
      else await db.query('UPDATE counts SET n = $1', [rows[0].n + 1]);
    } finally { await db.end(); }
  };
  return {
    name: 'two-increments', actors: { a: increment, b: increment },
    async setup({ db }) { await db.query('CREATE TABLE counts (n int); INSERT INTO counts VALUES (0)'); },
    async invariant({ db }) { assert.equal((await db.query('SELECT n FROM counts')).rows[0].n, 2, 'both increments survive'); },
  };
}

describe('exploration integration', () => {
  test('finds a real violation and records bounded coverage without a safety claim', async () => {
    const result = await explore(race(), { databaseUrl, maxRuns: 10 });
    expect(result.firstFailure?.outcome).toBe('violation');
    expect(result.stopReason).toBe('failure');
    expect(result.explored).toBeGreaterThan(0);
    expect(result.coverage).toMatch(/bounded|observed/i);
  });

  test('explores alternate orders and reports an unfinished frontier at the run budget', async () => {
    const result = await explore(race(true), { databaseUrl, maxRuns: 2, stopOnFailure: false });
    expect(result.runs).toHaveLength(2);
    expect(result.runs.every(run => run.outcome === 'passed')).toBe(true);
    expect(result.pending).toBeGreaterThan(0);
    expect(result.stopReason).toBe('max-runs');
    expect(new Set(result.runs.map(run => run.trace.map(step => step.actor).join(''))).size).toBe(2);
  });

  test('seeded exploration discovers a fresh exact-replayable failure after a passing serial plan', async () => {
    const databases: string[] = [];
    const scenario = race();
    const setup = scenario.setup;
    scenario.setup = async context => {
      const { rows } = await context.db.query<{ name: string }>('SELECT current_database() AS name');
      databases.push(rows[0]!.name);
      console.info('[seeded-exploration-database]', rows[0]!.name);
      await setup(context);
    };
    try {
      const result = await explore(scenario, {
        databaseUrl, seed: 2, plan: ['a', 'a', 'b', 'b'], maxRuns: 4,
      });
      expect(result.search).toEqual({ version: 1, strategy: 'seeded', seed: 2 });
      expect(result.stopReason).toBe('failure');
      expect(result.runs.map(run => run.plan)).toEqual([['a', 'a', 'b', 'b'], ['b']]);
      expect(result.runs.map(run => run.outcome)).toEqual(['passed', 'violation']);
      expect(result.runs.map(run => run.trace.map(step => step.actor))).toEqual([
        ['a', 'a', 'b', 'b'], ['b', 'a', 'b', 'a'],
      ]);
      expect(result.metrics).toEqual({
        attemptedRuns: 2, completedRuns: 2, maxAttemptedDepth: 4,
        recordedReleasedSteps: 8, recordedActorSwitches: 4, traceCountsComplete: true,
      });
      expect(result.runs.every(run => run.cleanup.complete)).toBe(true);
      expect(result.firstFailure).toBe(result.runs[1]);
      const original = parseRunArtifact(JSON.stringify(result.firstFailure));
      expect(original.environment.fixture).toBeDefined();
      expect(original.failure?.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      const exact = await replay(scenario, original, { databaseUrl });
      expect(exact.mode).toBe('replay');
      expect(exact.outcome).toBe('violation');
      expect(exact.environment.fixture).toEqual(original.environment.fixture);
      expect(exact.failure?.fingerprint).toBe(original.failure!.fingerprint);
      expect(exact.trace.map(step => [step.actor, step.sql, step.fingerprint])).toEqual(
        original.trace.map(step => [step.actor, step.sql, step.fingerprint]),
      );
      expect(exact.cleanup.complete).toBe(true);
      expect(databases).toHaveLength(3);
      expect(new Set(databases).size).toBe(3);
      expect(databases.every(name => /^interleave_[a-f0-9]+$/.test(name))).toBe(true);
    } finally {
      const administrator = new Client({ connectionString: databaseUrl });
      try {
        await administrator.connect();
        const { rows } = await administrator.query<{ datname: string }>(
          'SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname', [databases],
        );
        console.info('[seeded-exploration-cleanup]', JSON.stringify({ databases, remaining: rows.map(row => row.datname) }));
        expect(rows).toEqual([]);
      } finally { await administrator.end(); }
    }
  });

  test('replays the exact failure three times against fresh real databases', async () => {
    const original = await runOnce(race(), { databaseUrl });
    expect(original.outcome).toBe('violation');
    for (let repeat = 0; repeat < 3; repeat++) {
      const next = await replay(race(), original, { databaseUrl });
      expect(next.mode).toBe('replay');
      expect(next.failure?.fingerprint).toBe(original.failure?.fingerprint);
      expect(next.trace.map(s => s.fingerprint)).toEqual(original.trace.map(s => s.fingerprint));
    }
  });

  test('never confuses a query-changing fix with an exact replay', async () => {
    const original = await runOnce(race(), { databaseUrl });
    const exact = await replay(race(true), original, { databaseUrl });
    expect(exact.outcome).toBe('incompatible');
    const guided = await replay(race(true), original, { databaseUrl, mode: 'guided' });
    expect(guided.mode).toBe('guided');
    expect(guided.outcome).toBe('passed');
  });

  test('reduces explicit ordering instructions while keeping the same failure', async () => {
    const original = await runOnce(race(), { databaseUrl, plan: ['a', 'b', 'a', 'b'] });
    const result = await minimize(race(), original, { databaseUrl, maxAttempts: 20 });
    expect(result.originalChoices).toBe(4);
    expect(result.reducedChoices).toBeLessThan(4);
    expect(result.run.failure?.fingerprint).toBe(original.failure?.fingerprint);
    expect(result.attempts).toBeGreaterThan(0);
    const exact = await replay(race(), result.run, { databaseUrl });
    expect(exact.failure?.fingerprint).toBe(original.failure?.fingerprint);
  });

  test('refuses to minimize when the original failure no longer reproduces', async () => {
    const original = await runOnce(race(), { databaseUrl });
    await expect(minimize(race(true), original, { databaseUrl })).rejects.toThrow(/reproduc|compatible|failure/i);
  });
});

test('exploration integration keeps file-based discovery, replay and reduction supervised', async () => {
  const { fileURLToPath } = await import('node:url');
  const target = fileURLToPath(new URL('./fixtures/supervised/counter.ts', import.meta.url));
  const discovered = await explore(target, { databaseUrl, maxRuns: 5 });
  expect(discovered.firstFailure?.outcome).toBe('violation');
  const reproduced = await replay(target, discovered.firstFailure!, { databaseUrl });
  expect(reproduced.failure?.fingerprint).toBe(discovered.firstFailure!.failure?.fingerprint);
  const reduced = await minimize(target, reproduced, { databaseUrl, maxAttempts: 5 });
  expect(reduced.run.outcome).toBe('violation');
  expect(reduced.run.cleanup.complete).toBe(true);
  expect(reduced.stopReason).toMatch(/locally-minimal|max-attempts/);
});

test('exploration integration interrupts a hung scenario file at the whole-search deadline', async () => {
  const { fileURLToPath } = await import('node:url');
  const target = fileURLToPath(new URL('./fixtures/supervised/hung-setup.ts', import.meta.url));
  const started = Date.now();
  const result = await explore(target, { databaseUrl, timeoutMs: 10_000, totalTimeoutMs: 800 });
  expect(result.stopReason).toBe('deadline');
  expect(result.runs[0]?.outcome).toBe('inconclusive');
  expect(result.runs[0]?.cleanup.complete).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
});
