import { parseRunArtifact } from './artifact.js';
import { assertCompletedRun } from './completed-run.js';
import { runTarget } from './run-target.js';
import { sourceSelection } from './source-selection.js';
import { resolveFixtureProfile } from './fixture-profile.js';
import type { Scenario, RunOptions, RunResult } from './types.js';

/** Exact matching is the default; guided mode creates a separately labeled trace. */
export async function replay(scenario: Scenario | string, original: RunResult, options: RunOptions): Promise<RunResult> {
  const recorded = parseRunArtifact(original);
  if (options.mode === 'explore') throw new TypeError('Use explore() to discover new schedules');
  if (options.mode === 'guided') {
    const { replay: _ignored, ...guided } = options;
    const source = typeof scenario === 'string' ? sourceSelection(scenario, options.source, recorded.environment.source) : undefined;
    return runTarget(scenario, { ...guided, maxConnectionsPerActor: options.maxConnectionsPerActor === undefined ? recorded.limits.maxConnectionsPerActor ?? 1 : options.maxConnectionsPerActor,
      protocolProfile: options.protocolProfile === undefined ? recorded.limits.protocolProfile ?? 'sync-cycle-v1' : options.protocolProfile,
      fixtureProfile: resolveFixtureProfile(options.fixtureProfile, recorded.environment.fixture),
      ...(source ? { source } : {}),
      plan: recorded.trace.map(step => step.actor), mode: 'guided' });
  }
  assertCompletedRun(recorded);
  return runTarget(scenario, { ...options, replay: recorded, mode: 'replay' });
}
