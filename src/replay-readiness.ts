import type { RunResult } from './types.js';

/** Legacy records remain readable, but these identities are required for exact execution. */
export function missingReplayIdentity(run: RunResult): string | undefined {
  if (run.connections === undefined) return 'The recorded run has no actor connection identities; use a guided run to create new bound evidence';
  if (run.environment.fixture === undefined) return 'The recorded run has no fixture identity; use a guided run to create new bound evidence';
  return undefined;
}
