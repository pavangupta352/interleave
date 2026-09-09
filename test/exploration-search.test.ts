import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import type { ExploreOptions, RunResult, Scenario } from '../src/types.js';

// Only the external execution boundary is replaced; frontier generation,
// selection, artifact validation, retention and accounting run normally.
const execution = vi.hoisted(() => vi.fn());
vi.mock('../src/runner.js', () => ({ runOnce: execution }));
vi.mock('../src/supervised.js', () => ({ runScenarioFile: execution }));
import { explore } from '../src/explore.js';

const scenario: Scenario = { name: 'search', setup: async () => {}, actors: { a: async () => {}, b: async () => {} }, invariant: async () => {} };
function artifact(actors = ['a', 'a', 'b']): RunResult {
  const ordinals = new Map<string, number>();
  return {
    schemaVersion: 1, scenario: 'search', mode: 'explore', outcome: 'passed', plan: [],
    trace: actors.map((actor, index) => {
      const ordinal = ordinals.get(actor) ?? 0;
      ordinals.set(actor, ordinal + 1);
      return { index, actor, connection: 0, ordinal, protocol: 'simple', sql: 'SELECT 1; SELECT 2', fingerprint: 'a'.repeat(64), backendPid: actor === 'a' ? 1 : 2, available: ['a', 'b'], releasedAt: index, completedAt: index + 1, completion: { transactionStatus: 'I', commandTags: ['SELECT 1', 'SELECT 1'], rowCount: 2 }, waits: [] };
    }),
    actors: ['a', 'b'].map(actor => ({ actor, status: 'fulfilled' })),
    environment: { serverVersion: '16.13', nodeVersion: process.version },
    startedAt: '2026-09-09T00:00:00.000Z', durationMs: 10,
    limits: { maxSteps: 100, timeoutMs: 10000 }, cleanup: { complete: true },
  };
}
afterEach(() => { execution.mockReset(); vi.restoreAllMocks(); });

async function attemptedPlans(options: Partial<ExploreOptions>) {
  execution.mockImplementation(async (_target, runOptions) => ({ ...artifact(), plan: runOptions.plan }));
  const result = await explore(scenario, { databaseUrl: 'test', maxRuns: 4, ...options });
  return { result, plans: result.runs.map(run => run.plan) };
}

describe('bounded frontier selection', () => {
  test.each([{}, { strategy: 'fifo' as const }])('preserves latest-deviation-first FIFO with %j', async options => {
    const { result, plans } = await attemptedPlans(options);
    expect(plans).toEqual([[], ['a', 'a', 'a'], ['a', 'b'], ['b']]);
    expect(result.search).toEqual({ version: 1, strategy: 'fifo' });
    expect(result.stopReason).toBe('frontier-exhausted');
  });

  test('keeps a supplied initial prefix first and measures dispatched depth only', async () => {
    const { result, plans } = await attemptedPlans({ seed: 0, plan: ['b'], maxRuns: 1 });
    expect(plans).toEqual([['b']]);
    expect(result.pending).toBe(2);
    expect(result.metrics.maxAttemptedDepth).toBe(1);
  });

  // Golden order independently calculated from the documented SHA-256 bytes:
  // seed 0, counters 1..3: b34b3f20, 12b1847a, 9ce9f7e1.
  // uint32 max: ec0d0101, 57fecaa7, ed5165d7. Counter 0 consumes [] first.
  test.each([
    [0, [[], ['a', 'b'], ['a', 'a', 'a'], ['b']]],
    [4294967295, [[], ['b'], ['a', 'b'], ['a', 'a', 'a']]],
  ])('reproduces the versioned seed %i order across fresh searches', async (seed, expected) => {
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('ambient randomness'); });
    for (const options of [{ seed }, { seed, strategy: 'seeded' as const }]) {
      const { result, plans } = await attemptedPlans(options);
      expect(plans).toEqual(expected);
      expect(result.search).toEqual({ version: 1, strategy: 'seeded', seed });
      expect(result.metrics).toEqual({ attemptedRuns: 4, completedRuns: 4, maxAttemptedDepth: 3, recordedReleasedSteps: 12, recordedActorSwitches: 4, traceCountsComplete: true });
    }
  });

  test.each([
    { strategy: 'unknown' }, { strategy: 'seeded' }, { strategy: 'fifo', seed: 0 },
    ...[-0, -1, 4294967296, 0.5, NaN, Infinity, -Infinity, '0', true, null].map(seed => ({ seed })),
  ])('rejects invalid selection before loading or executing a file: %j', async options => {
    execution.mockResolvedValue(artifact());
    await expect(explore('/unimported/scenario.mjs', { databaseUrl: 'test', ...options } as ExploreOptions)).rejects.toThrow(/seed|strategy/i);
    expect(execution).not.toHaveBeenCalled();
  });

  test('keeps all search-only fields out of both runner and worker options', async () => {
    execution.mockResolvedValue(artifact());
    for (const target of [scenario, '/unimported/scenario.mjs']) {
      await explore(target, { databaseUrl: 'test', strategy: 'seeded', seed: 0, maxRuns: 1, maxCandidates: 5, maxSearchBytes: 4096, totalTimeoutMs: 1000, stopOnFailure: false, maxSteps: 12, timeoutMs: 500 });
    }
    for (const [, options] of execution.mock.calls) {
      expect(Object.keys(options).sort()).toEqual(['databaseUrl', 'maxSteps', 'mode', 'plan', 'signal', 'timeoutMs']);
      expect(options).toMatchObject({ databaseUrl: 'test', maxSteps: 12, timeoutMs: 500, plan: [], mode: 'explore' });
    }
  });
});

describe('metrics across observed attempts', () => {
  test('counts release units and within-run actor transitions, including reconnects', async () => {
    const first = artifact();
    first.trace[1]!.connection = 1;
    first.trace[1]!.ordinal = 0;
    first.trace[1]!.backendPid = 3;
    parseRunArtifact(first);
    execution.mockResolvedValueOnce(first).mockResolvedValueOnce(artifact(['b', 'a']));
    const result = await explore(scenario, { databaseUrl: 'test', seed: 0, maxRuns: 2 });
    expect(result.metrics).toEqual({ attemptedRuns: 2, completedRuns: 2, maxAttemptedDepth: 2, recordedReleasedSteps: 5, recordedActorSwitches: 2, traceCountsComplete: true });
  });

  test('counts completed describe/execute and error/recover stages as four release units', async () => {
    const run = artifact(['a', 'a', 'b', 'b']);
    run.schemaVersion = 2;
    run.connections = ['a', 'b'].map(actor => ({ actor, connection: 0, fingerprint: 'b'.repeat(64) }));
    run.limits.protocolProfile = 'describe-flush-v1';
    run.trace.forEach((step, index) => {
      step.protocol = 'extended'; step.cycle = 0;
      step.stage = index % 2 === 0 ? 'describe' : index === 1 ? 'execute' : 'recover';
      if (index % 2 === 0) step.completion = index === 0
        ? { kind: 'metadata', result: 'described', parameterCount: 0, columnCount: 1, resultShape: 'rows' }
        : { kind: 'metadata', result: 'error', error: { code: '42601', message: 'syntax error' } };
      else {
        step.prefixOrdinal = 0;
        step.completion = { kind: 'ready', transactionStatus: 'I', commandTags: index === 1 ? ['SELECT 1'] : [], rowCount: index === 1 ? 1 : 0 };
      }
    });
    parseRunArtifact(run);
    execution.mockResolvedValue(run);
    const result = await explore(scenario, { databaseUrl: 'test', maxRuns: 1 });
    expect(result.metrics).toMatchObject({ completedRuns: 1, recordedReleasedSteps: 4, recordedActorSwitches: 1, traceCountsComplete: true });
  });

  test.each(['passed', 'violation', 'actor-error'] as const)('counts completed %s evidence even when retention omits it', async outcome => {
    const run = artifact();
    run.outcome = outcome;
    if (outcome === 'violation') run.failure = { name: 'AssertionError', message: 'invariant', fingerprint: 'b'.repeat(64) };
    if (outcome === 'actor-error') run.actors[0] = { actor: 'a', status: 'rejected', error: 'application failed' };
    run.trace[0]!.sql += ' /*' + 'x'.repeat(4000) + '*/';
    parseRunArtifact(run);
    execution.mockResolvedValue(run);
    const result = await explore(scenario, { databaseUrl: 'test', maxSearchBytes: 1024 });
    expect(result.stopReason).toBe('max-search-bytes');
    expect(result.omittedRuns).toBe(1);
    expect(result.runs).toEqual([]);
    expect(result.metrics).toEqual({ attemptedRuns: 1, completedRuns: 1, maxAttemptedDepth: 0, recordedReleasedSteps: 3, recordedActorSwitches: 1, traceCountsComplete: true });
    expect(result.hardFailureCount).toBe(outcome === 'actor-error' ? 1 : 0);
    expect(result.violationCount).toBe(outcome === 'violation' ? 1 : 0);
  });

  test.each(['incompatible', 'inconclusive', 'harness-error'] as const)('marks %s trace counts as partial even when all listed steps completed', async outcome => {
    const run = artifact(); run.outcome = outcome;
    execution.mockResolvedValue(run);
    const result = await explore(scenario, { databaseUrl: 'test', maxRuns: 1 });
    expect(result.metrics).toMatchObject({ attemptedRuns: 1, completedRuns: 0, recordedReleasedSteps: 3, recordedActorSwitches: 1, traceCountsComplete: false });
  });

  test('counts only recorded partial evidence and never restores completeness on a later pass', async () => {
    const run = artifact(['a', 'b']); run.outcome = 'incompatible';
    delete run.trace[1]!.completion; delete run.trace[1]!.completedAt;
    parseRunArtifact(run);
    execution.mockResolvedValueOnce(run).mockResolvedValueOnce(artifact(['b', 'a']));
    const result = await explore(scenario, { databaseUrl: 'test', maxRuns: 2 });
    expect(result.metrics).toMatchObject({ attemptedRuns: 2, completedRuns: 1, recordedReleasedSteps: 4, recordedActorSwitches: 2, traceCountsComplete: false });
  });

  test.each(['trace', 'cleanup'])('does not count a passed outcome as completed when %s is incomplete', async boundary => {
    // Legacy schema 1 permits these partial shapes, so an admissible outcome
    // alone must not turn missing completion/cleanup evidence into complete work.
    const run = artifact();
    if (boundary === 'trace') { delete run.trace[2]!.completion; delete run.trace[2]!.completedAt; }
    else run.cleanup = { complete: false, error: 'owned cleanup failed' };
    parseRunArtifact(run);
    execution.mockResolvedValue(run);
    const result = await explore(scenario, { databaseUrl: 'test', maxRuns: 1 });
    expect(result.metrics).toMatchObject({ attemptedRuns: 1, completedRuns: 0, recordedReleasedSteps: 3, recordedActorSwitches: 1, traceCountsComplete: false });
    expect(result.hardFailureCount).toBe(boundary === 'cleanup' ? 1 : 0);
  });

  test('does not present cleared evidence as an exact zero-work total', async () => {
    const run = artifact([]); run.outcome = 'inconclusive'; run.actors = [];
    execution.mockResolvedValue(run);
    const result = await explore(scenario, { databaseUrl: 'test' });
    expect(result.metrics).toMatchObject({ attemptedRuns: 1, completedRuns: 0, recordedReleasedSteps: 0, recordedActorSwitches: 0, traceCountsComplete: false });
  });

  test('does not count an invalid artifact trace and preserves its known hard failure', async () => {
    const run = artifact(); run.outcome = 'harness-error'; run.trace[0]!.index = 99;
    execution.mockResolvedValue(run);
    const result = await explore(scenario, { databaseUrl: 'test' });
    expect(result.hardFailureCount).toBe(1);
    expect(result.omittedRuns).toBe(1);
    expect(result.metrics).toMatchObject({ attemptedRuns: 1, completedRuns: 0, recordedReleasedSteps: 0, recordedActorSwitches: 0, traceCountsComplete: false });
  });

  test('retains cleanup failure classification and partial counts after cancellation', async () => {
    const controller = new AbortController();
    const run = artifact(); run.outcome = 'harness-error'; run.cleanup = { complete: false, error: 'owned cleanup failed' };
    execution.mockImplementation(async () => { controller.abort(); return run; });
    const result = await explore(scenario, { databaseUrl: 'test', seed: 0, signal: controller.signal });
    expect(result.stopReason).toBe('aborted');
    expect(result.hardFailureCount).toBe(1);
    expect(result.metrics).toMatchObject({ attemptedRuns: 1, completedRuns: 0, recordedReleasedSteps: 3, traceCountsComplete: false });
  });

  test.each(['aborted', 'max-search-bytes'])('counts no dispatch for a pre-dispatch %s stop', async reason => {
    const options: ExploreOptions = { databaseUrl: 'test', seed: 0 };
    if (reason === 'aborted') options.signal = AbortSignal.abort();
    else { options.plan = Array(400).fill('a'); options.maxSearchBytes = 1024; }
    const result = await explore(scenario, options);
    expect(result.stopReason).toBe(reason);
    expect(execution).not.toHaveBeenCalled();
    expect(result.metrics).toEqual({ attemptedRuns: 0, completedRuns: 0, maxAttemptedDepth: 0, recordedReleasedSteps: 0, recordedActorSwitches: 0, traceCountsComplete: true });
  });
});
