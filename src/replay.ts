import { parseRunArtifact } from './artifact.js';
import { runTarget } from './run-target.js';
import type { Scenario, RunOptions, RunResult } from './types.js';

/** Exact matching is the default; guided mode creates a separately labeled trace. */
export async function replay(scenario: Scenario | string, original: RunResult, options: RunOptions): Promise<RunResult> {
  const recorded = parseRunArtifact(original);
  if (options.mode === 'explore') throw new TypeError('Use explore() to discover new schedules');
  if (options.mode === 'guided') {
    const { replay: _ignored, ...guided } = options;
    return runTarget(scenario, { ...guided, plan: recorded.trace.map(step => step.actor), mode: 'guided' });
  }
  if (!['passed', 'violation', 'actor-error'].includes(recorded.outcome) || !recorded.cleanup.complete || recorded.trace.some(step => !step.completion)) {
    throw new TypeError('Exact replay requires a completed run with complete trace and cleanup');
  }
  return runTarget(scenario, { ...options, replay: recorded, mode: 'replay' });
}
