import type { RunResult } from './types.js';

/** Apply after schema validation, before reusing evidence as an exact execution. */
export function assertCompletedRun(run: RunResult): void {
  if (!['passed', 'violation', 'actor-error'].includes(run.outcome)
    || !run.cleanup.complete
    || run.trace.some(step => step.completion === undefined || step.completedAt === undefined)) {
    throw new TypeError('Exact execution evidence requires a completed run with complete trace and cleanup');
  }
}
