import { parseRunArtifact } from './artifact.js';
import { runTarget } from './run-target.js';
import { defineScenario } from './scenario.js';
import { integerLimit, searchBudget } from './search-budget.js';
import type { Scenario, ExploreOptions, ExplorationResult } from './types.js';

/** Explore observed actor-choice prefixes; a bounded search is not a safety proof. */
export async function explore(input: Scenario | string, options: ExploreOptions): Promise<ExplorationResult> {
  const scenario = typeof input === 'string' ? input : defineScenario(input);
  const maxRuns = integerLimit(options.maxRuns, 100, 10_000, 'maxRuns');
  const maxCandidates = integerLimit(options.maxCandidates, 10_000, 100_000, 'maxCandidates');
  const maxSearchBytes = integerLimit(options.maxSearchBytes, 64 * 1024 * 1024, 256 * 1024 * 1024, 'maxSearchBytes', 1024);
  if (options.replay || (options.mode && options.mode !== 'explore')) throw new TypeError('Exploration cannot use replay or guided mode');
  if (options.plan && (!Array.isArray(options.plan) || options.plan.length > 100_000 || options.plan.some(actor => typeof actor !== 'string' || actor.length > 48))) throw new TypeError('Invalid initial schedule');
  // Store each prefix once as an encoded string shared by the queue and seen set.
  const initial = JSON.stringify(options.plan ?? []);
  const frontier: string[] = [initial];
  const seen = new Set(frontier);
  const result: ExplorationResult = {
    schemaVersion: 1, scenario: typeof scenario === 'string' ? scenario : scenario.name,
    runs: [], explored: 0, pending: 1, retainedBytes: Buffer.byteLength(initial), omittedRuns: 0, violationCount: 0, hardFailureCount: 0,
    stopReason: 'frontier-exhausted',
    coverage: 'Bounded exploration of observed actor command-release choices. Database execution, external work and unsampled schedules remain outside this result. Retained bytes measure encoded results and candidate keys, not process heap usage.',
  };
  const budget = searchBudget(options.totalTimeoutMs, options.signal);
  try {
    if (result.retainedBytes > maxSearchBytes) { result.retainedBytes = 0; result.pending = 0; result.stopReason = 'max-search-bytes'; return result; }
    search: while (frontier.length && result.explored < maxRuns) {
      const interruption = budget.reason();
      if (interruption) { result.stopReason = interruption; break; }
      const plan = JSON.parse(frontier.shift()!) as string[];
      const run = await runTarget(scenario, { ...options, signal: budget.signal, plan, mode: 'explore' });
      result.scenario = run.scenario;
      result.explored++;
      if (run.outcome === 'violation') result.violationCount++;
      if (run.outcome === 'harness-error' || run.outcome === 'actor-error' || !run.cleanup.complete) result.hardFailureCount++;
      let bytes: number;
      try { bytes = Buffer.byteLength(JSON.stringify(parseRunArtifact(run))); }
      catch { bytes = Number.POSITIVE_INFINITY; }
      if (result.retainedBytes + bytes > maxSearchBytes) {
        result.omittedRuns++;
        result.stopReason = 'max-search-bytes';
        break;
      }
      result.retainedBytes += bytes;
      result.runs.push(run);
      if (run.outcome === 'violation') result.firstFailure ??= run;
      const interrupted = budget.reason();
      if (interrupted) { result.stopReason = interrupted; break; }
      if (run.outcome === 'violation' && options.stopOnFailure !== false) { result.stopReason = 'failure'; break; }
      if (['inconclusive', 'harness-error', 'actor-error'].includes(run.outcome)) { result.stopReason = 'inconclusive'; break; }
      const choices = run.trace.map(step => step.actor);
      const prefixBytes = [1];
      for (const actor of choices) prefixBytes.push(prefixBytes.at(-1)! + Buffer.byteLength(JSON.stringify(actor)) + 1);
      // Latest deviations first; the loop checks elapsed time even without an await.
      for (let index = run.trace.length - 1; index >= 0; index--) {
        const stopped = budget.reason();
        if (stopped) { result.stopReason = stopped; break search; }
        for (const alternative of run.trace[index]!.available) {
          if (alternative === choices[index]) continue;
          const keyBytes = prefixBytes[index]! + Buffer.byteLength(JSON.stringify(alternative)) + 1;
          const key = JSON.stringify([...choices.slice(0, index), alternative]);
          if (seen.has(key)) continue;
          if (result.retainedBytes + keyBytes > maxSearchBytes) { result.stopReason = 'max-search-bytes'; break search; }
          if (seen.size >= maxCandidates) { result.stopReason = 'max-candidates'; break search; }
          result.retainedBytes += keyBytes;
          seen.add(key);
          frontier.push(key);
        }
      }
    }
    result.pending = frontier.length;
    if (result.stopReason === 'frontier-exhausted' && frontier.length) result.stopReason = 'max-runs';
    return result;
  } finally { budget.close(); }
}
