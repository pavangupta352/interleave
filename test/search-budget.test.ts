import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RunResult, Scenario } from '../src/types.js';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/runner.js', () => ({ runOnce: mocks.run }));
vi.mock('../src/supervised.js', () => ({ runScenarioFile: mocks.run }));
import { explore } from '../src/explore.js';
import { minimize } from '../src/minimize.js';
import { replay } from '../src/replay.js';
import { minimizationExitCode } from '../src/cli/status.js';

const scenario: Scenario = { name: 'budgeted', setup: async () => {}, actors: { a: async () => {}, b: async () => {} }, invariant: async () => {} };
function result(outcome: RunResult['outcome'] = 'passed'): RunResult {
  return {
    schemaVersion: 1, scenario: 'budgeted', outcome, mode: 'explore', plan: [],
    trace: ['a', 'b'].map((actor, index) => ({ index, actor, connection: 0, ordinal: 0, protocol: 'simple', sql: 'SELECT 1', fingerprint: 'a'.repeat(64), backendPid: index + 1, available: ['a', 'b'], releasedAt: index, completedAt: index + 1, completion: { transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 }, waits: [] })),
    actors: ['a', 'b'].map(actor => ({ actor, status: 'fulfilled' })),
    ...(outcome === 'violation' ? { failure: { name: 'AssertionError', message: 'lost update', fingerprint: 'b'.repeat(64) } } : {}),
    environment: { serverVersion: '16.13', nodeVersion: process.version, fixture: {
      version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256', fingerprint: 'c'.repeat(64),
      components: { schema: 'd'.repeat(64), data: 'e'.repeat(64), sequences: 'f'.repeat(64), settings: 'a'.repeat(64) },
      counts: { objects: 1, rows: 0, bytes: 100 },
    } }, startedAt: new Date().toISOString(), durationMs: 5, limits: { maxSteps: 100, timeoutMs: 10000 }, cleanup: { complete: true },
  };
}
afterEach(() => { vi.useRealTimers(); mocks.run.mockReset(); });

describe('whole-search resource budgets', () => {
  test('cancels an active exploration run at the overall deadline', async () => {
    vi.useFakeTimers();
    mocks.run.mockImplementation(async (_scenario, options) => new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ ...result(), outcome: 'inconclusive', reason: 'cancelled' }), { once: true })));
    const search = explore(scenario, { databaseUrl: 'test', totalTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(26);
    const actual = await search;
    expect(actual.stopReason).toBe('deadline');
    expect(actual.explored).toBe(1);
    expect(actual.runs[0]?.outcome).toBe('inconclusive');
  });

  test('reports candidate saturation instead of a falsely exhausted frontier', async () => {
    mocks.run.mockResolvedValue(result());
    const actual = await explore(scenario, { databaseUrl: 'test', maxRuns: 20, maxCandidates: 1 });
    expect(actual.stopReason).toBe('max-candidates');
    expect(actual.explored).toBe(1);
  });

  test('bounds retained results and records the truncation', async () => {
    const large = result();
    large.trace[0]!.sql = 'SELECT 1 /*' + 'x'.repeat(8000) + '*/';
    mocks.run.mockResolvedValue(large);
    const actual = await explore(scenario, { databaseUrl: 'test', maxSearchBytes: 2048 });
    expect(actual.stopReason).toBe('max-search-bytes');
    expect(actual.explored).toBe(1);
    expect(actual.runs).toHaveLength(0);
    expect(actual.retainedBytes).toBeLessThanOrEqual(2048);
  });

  test('executes file targets through supervision', async () => {
    mocks.run.mockResolvedValue(result('violation'));
    const actual = await explore('/tmp/trusted-scenario.mjs', { databaseUrl: 'test' });
    expect(actual.scenario).toBe('budgeted');
    expect(actual.firstFailure?.outcome).toBe('violation');
    expect(mocks.run).toHaveBeenCalledWith('/tmp/trusted-scenario.mjs', expect.objectContaining({ mode: 'explore' }));
  });

  test('rejects incomplete evidence as an exact replay source before execution', async () => {
    const incomplete = result();
    incomplete.outcome = 'inconclusive';
    incomplete.reason = 'budget';
    await expect(replay(scenario, incomplete, { databaseUrl: 'test' })).rejects.toThrow(/complete|completed/i);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  test('stops reduction at the shared deadline and retains only the last verified failure', async () => {
    vi.useFakeTimers();
    const original = result('violation');
    mocks.run.mockResolvedValueOnce(original).mockImplementation(async (_scenario, options) => new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ ...result(), outcome: 'inconclusive', reason: 'cancelled' }), { once: true })));
    const search = minimize(scenario, original, { databaseUrl: 'test', totalTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(26);
    const actual = await search;
    expect(actual.stopReason).toBe('deadline');
    expect(actual.locallyMinimal).toBe(false);
    expect(actual.run).toEqual(original);
  });
});

test('deduplicated prefixes do not falsely exhaust an exactly sufficient byte budget', async () => {
  mocks.run.mockImplementation(async (_scenario, options) => {
    const run = result();
    const first = options.plan[0] === 'b' ? 'b' : 'a';
    const last = first === 'a' ? 'b' : 'a';
    run.plan = options.plan;
    run.trace = [first, last].map((actor, index) => ({ ...run.trace[index]!, actor, backendPid: actor === 'a' ? 1 : 2, available: index === 0 ? ['a', 'b'] : [last] }));
    return run;
  });
  const full = await explore(scenario, { databaseUrl: 'test', maxRuns: 10 });
  expect(full.stopReason).toBe('frontier-exhausted');
  const exact = await explore(scenario, { databaseUrl: 'test', maxRuns: 10, maxSearchBytes: full.retainedBytes });
  expect(exact.stopReason).toBe('frontier-exhausted');
  expect(exact.retainedBytes).toBe(full.retainedBytes);
});

test('hard application and harness failures remain counted when their artifacts are omitted', async () => {
  for (const outcome of ['actor-error', 'harness-error'] as const) {
    const run = result();
    run.outcome = outcome;
    run.reason = 'failure';
    run.actors[0] = { actor: 'a', status: 'rejected', error: 'x'.repeat(4000) };
    mocks.run.mockResolvedValue(run);
    const search = await explore(scenario, { databaseUrl: 'test', maxSearchBytes: 1024 });
    expect(search.hardFailureCount).toBe(1);
    expect(search.runs).toHaveLength(0);
  }
});

test('a shared cancellation does not erase a reduction attempt cleanup failure', async () => {
  const original=result('violation');
  const controller=new AbortController();
  mocks.run.mockResolvedValueOnce(original).mockImplementationOnce(async()=>{
    controller.abort();
    return {...result(),outcome:'harness-error',reason:'Owned cleanup failed',cleanup:{complete:false,error:'Owned database interleave_cleanup_target remains'}};
  });
  const reduced=await minimize(scenario,original,{databaseUrl:'test',signal:controller.signal});
  expect(reduced.attemptFailure).toMatchObject({outcome:'harness-error',cleanup:{complete:false,error:'Owned database interleave_cleanup_target remains'}});
  expect(reduced.run.failure?.fingerprint).toBe(original.failure?.fingerprint);
  expect(reduced.locallyMinimal).toBe(false);expect(minimizationExitCode(reduced)).toBe(2);
});

test('reduction keeps searching after an infeasible schedule with unchanged starting conditions', async () => {
  const original = result('violation');
  mocks.run.mockResolvedValueOnce(original)
    .mockResolvedValueOnce({ ...result('incompatible'), reason: 'Requested actor has no queued statement' })
    .mockResolvedValue(original);
  const reduced = await minimize(scenario, original, { databaseUrl: 'test', maxAttempts: 5 });
  expect(reduced.stopReason).toBe('locally-minimal');
  expect(reduced.reducedChoices).toBe(0);
  expect(reduced.attempts).toBe(4);
  expect(reduced.reason).toBeUndefined();
});

test('an attempt limit inside a candidate group cannot claim local minimality', async () => {
  const original = result('violation');
  mocks.run.mockResolvedValueOnce(original).mockResolvedValue(result('passed'));
  const reduced = await minimize(scenario, original, { databaseUrl: 'test', maxAttempts: 2 });
  expect(reduced.stopReason).toBe('max-attempts');
  expect(reduced.locallyMinimal).toBe(false);
  expect(reduced.attempts).toBe(2);
  expect(reduced.reducedChoices).toBe(2);
  expect(reduced.run).toEqual(original);
});
