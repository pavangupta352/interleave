import { describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { explore } from '../src/explore.js';
import { minimize } from '../src/minimize.js';
import { replay } from '../src/replay.js';
import { runOnce } from '../src/runner.js';
import type { RunResult } from '../src/types.js';
import { atomicIncrement, pooledStatementRace, statementRace } from './fixtures/overlap.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const pairs = { databaseUrl, overlap: 'pairs' as const };
const identities = (run: RunResult) => run.trace.map(step => [step.actor, step.ordinal, step.sql, step.fingerprint, step.overlap]);

describe('statement overlap against real PostgreSQL', () => {
  test('one-at-a-time release never reaches a race inside a statement', async () => {
    const search = await explore(statementRace(), { databaseUrl, maxRuns: 10 });
    expect(search.violationCount, JSON.stringify(search.runs.map(run => [run.plan, run.outcome, run.reason]))).toBe(0);
    expect(search.stopReason).toBe('frontier-exhausted');
    expect(search.runs.every(run => run.schemaVersion === 3 && run.limits.overlap === undefined)).toBe(true);
  });

  test('an overlapped pair finds it, replays it, reruns it and keeps the pair when reducing', async () => {
    const scenario = statementRace();
    const search = await explore(scenario, { ...pairs, maxRuns: 10 });
    const found = search.firstFailure;
    expect(found?.outcome, JSON.stringify(search.runs.map(run => [run.plan, run.outcome, run.reason]))).toBe('violation');
    expect(found!.plan).toEqual(['alice+bob']);
    expect(found!.failure?.message).toMatch(/Exactly one holder/);
    expect(found!.schemaVersion).toBe(4);
    expect(found!.limits).toMatchObject({ connectionProfile: 'single-producer-v1', overlap: 'pairs', maxConnectionsPerActor: 1 });
    const [first, second] = found!.trace;
    expect(found!.trace).toHaveLength(2);
    expect([first!.actor, second!.actor, first!.overlap, second!.overlap]).toEqual(['alice', 'bob', 0, 0]);
    expect(second!.releasedAt).toBe(first!.releasedAt);
    expect(first!.available).toEqual(['alice', 'bob']);
    // Both statements ran their pause at the same time and each inserted a row.
    for (const step of found!.trace) {
      expect(step.completion).toMatchObject({ transactionStatus: 'I', commandTags: ['INSERT 0 1'], rowCount: 1 });
      expect(step.completedAt! - step.releasedAt).toBeGreaterThanOrEqual(150);
    }
    expect(parseRunArtifact(JSON.parse(JSON.stringify(found)))).toEqual(found);

    for (let attempt = 0; attempt < 2; attempt++) {
      const repeated = await replay(scenario, parseRunArtifact(JSON.stringify(found)), { databaseUrl });
      expect(repeated.outcome, repeated.reason).toBe('violation');
      expect(repeated.failure).toEqual(found!.failure);
      expect(repeated.limits.overlap).toBe('pairs');
      expect(identities(repeated)).toEqual(identities(found!));
    }
    const guided = await replay(scenario, found!, { databaseUrl, mode: 'guided' });
    expect(guided.outcome, guided.reason).toBe('violation');
    expect(guided.plan).toEqual(['alice+bob']);
    expect(guided.limits.overlap).toBe('pairs');

    const reduced = await minimize(scenario, found!, { databaseUrl, maxAttempts: 8 });
    expect(reduced.plan).toEqual(['alice+bob']);
    expect(reduced.reducedChoices).toBe(1);
    expect(reduced.locallyMinimal).toBe(true);
    expect(reduced.run.outcome).toBe('violation');
  });

  test('a sequential plan with overlap enabled records no pair', async () => {
    const run = await runOnce(statementRace(), { ...pairs, plan: ['bob', 'alice'] });
    expect(run.outcome, run.reason).toBe('passed');
    expect(run.schemaVersion).toBe(4);
    expect(run.trace.map(step => [step.actor, step.overlap, step.completion?.rowCount])).toEqual([['bob', undefined, 1], ['alice', undefined, 0]]);
  });

  test('replay rejects an overlap mode that differs from the recording', async () => {
    const found = await runOnce(statementRace(), { ...pairs, plan: ['alice+bob'] });
    expect(found.outcome, found.reason).toBe('violation');
    const sequential: RunResult = JSON.parse(JSON.stringify(found));
    sequential.schemaVersion = 3; delete sequential.limits.overlap; delete sequential.limits.connectionProfile;
    sequential.plan = ['alice', 'bob'];
    for (const step of sequential.trace) delete step.overlap;
    const mismatch = await replay(statementRace(), parseRunArtifact(sequential), { ...pairs });
    expect(mismatch.outcome).toBe('incompatible');
    expect(mismatch.reason).toBe('Replay overlap mode differs from the recorded run');
  });

  test('atomic increments pass every overlapped and sequential choice', async () => {
    const search = await explore(atomicIncrement(), { ...pairs, maxRuns: 10 });
    expect(search.violationCount, JSON.stringify(search.runs.map(run => [run.plan, run.outcome, run.reason]))).toBe(0);
    expect(search.stopReason).toBe('frontier-exhausted');
    expect(search.runs.map(run => run.plan)).toEqual([[], ['bob'], ['alice+bob'], ['alice']]);
    const together = search.runs[2]!;
    expect(together.trace.map(step => step.overlap)).toEqual([0, 0]);
    expect(together.trace.map(step => step.completion?.rowCount)).toEqual([1, 1]);
  });

  test('prepared statements under describe-flush staging find the pair of executions', async () => {
    const scenario = statementRace('postgres.js');
    const search = await explore(scenario, { ...pairs, protocolProfile: 'describe-flush-v1', maxRuns: 40 });
    const found = search.firstFailure;
    expect(found?.outcome, JSON.stringify(search.runs.map(run => [run.plan, run.outcome]))).toBe('violation');
    const paired = found!.trace.filter(step => step.overlap !== undefined);
    expect(paired.map(step => step.stage)).toContain('execute');
    const exact = await replay(scenario, found!, { databaseUrl });
    expect(exact.outcome, exact.reason).toBe('violation');
    expect(identities(exact)).toEqual(identities(found!));
  });

  test('multi-producer pairs overlap two lanes of one actor and replay through lane binding', async () => {
    const scenario = pooledStatementRace();
    const base = { ...pairs, connectionProfile: 'multi-producer-v1' as const };
    const sequential = await runOnce(scenario, { ...base, plan: ['alice#0', 'alice#1', 'bob'] });
    expect(sequential.outcome, sequential.reason).toBe('passed');
    // Lane entries wait until the pool's second connection has queued its claim.
    const found = await runOnce(scenario, { ...base, plan: ['alice#0+alice#1', 'bob'] });
    expect(found.outcome, found.reason).toBe('violation');
    expect(found.limits).toMatchObject({ connectionProfile: 'multi-producer-v1', overlap: 'pairs' });
    const [first, second] = found.trace;
    expect([first!.actor, second!.actor, first!.overlap, second!.overlap]).toEqual(['alice', 'alice', 0, 0]);
    expect(first!.connection).not.toBe(second!.connection);
    expect(found.actors.find(actor => actor.actor === 'bob')?.value).toBe(2);
    expect(found.trace[0]!.available).toEqual(['alice#0', 'alice#1', 'bob#0']);
    for (let attempt = 0; attempt < 2; attempt++) {
      const repeated = await replay(scenario, parseRunArtifact(JSON.stringify(found)), { databaseUrl });
      expect(repeated.outcome, repeated.reason).toBe('violation');
      expect(identities(repeated)).toEqual(identities(found));
    }
  });
});
