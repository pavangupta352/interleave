import type { ExplorationResult, MinimizationResult, RunResult } from '../types.js';
export function runExitCode(run: RunResult): number {
  if (!run.cleanup.complete) return 2;
  return ({ passed: 0, violation: 1, 'actor-error': 2, 'harness-error': 2, incompatible: 3, inconclusive: 4 })[run.outcome];
}
export function explorationExitCode(search: ExplorationResult): number {
  if (search.hardFailureCount > 0 || search.runs.some(run => runExitCode(run) === 2)) return 2;
  if (['max-runs', 'max-candidates', 'max-search-bytes', 'deadline', 'aborted', 'inconclusive'].includes(search.stopReason)) return 4;
  if (search.violationCount > 0) return 1;
  if (!search.runs.length || search.runs.every(run => run.outcome === 'incompatible')) return 3;
  return 0;
}
export function minimizationExitCode(result: MinimizationResult): number {
  if (result.attemptFailure || runExitCode(result.run) === 2) return 2;
  return result.stopReason === 'locally-minimal' ? runExitCode(result.run) : 4;
}
