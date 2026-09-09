import { parseRunArtifact } from './artifact.js';
import type { RunResult } from './types.js';

/** Reserve room for a bounded interruption diagnostic without changing identity. */
export function assertEvidenceEnvelope(run: RunResult, maxBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(run)) + 256 > maxBytes) {
    throw new TypeError('maxEvidenceBytes is too small to preserve scenario identity and execution metadata');
  }
}

/** Every returned artifact, including an incomplete fallback, obeys its byte cap. */
export function finalizeRunEvidence(run: RunResult, maxBytes: number): RunResult {
  try {
    const validated = parseRunArtifact(run);
    if (Buffer.byteLength(JSON.stringify(validated)) <= maxBytes) return validated;
  } catch { /* Invalid or oversized evidence becomes explicitly incomplete below. */ }
  const { failure: _omittedFailure, ...partial } = run;
  const hardFailure = run.outcome === 'actor-error' || run.outcome === 'harness-error' || !run.cleanup.complete;
  const fallback = parseRunArtifact({
    // A hard failure remains a hard failure even when its complete actor/trace
    // evidence cannot fit. harness-error permits explicitly incomplete evidence.
    ...partial, outcome: hardFailure ? 'harness-error' : 'inconclusive', plan: [], trace: [], actors: [],
    ...(run.connections === undefined ? {} : { connections: [] }),
    reason: 'Execution evidence exceeded its recording limits or could not be represented as a valid artifact',
  });
  if (Buffer.byteLength(JSON.stringify(fallback)) > maxBytes) {
    const cleanup = run.cleanup.complete ? 'Owned cleanup completed.' : `Owned cleanup is incomplete: ${run.cleanup.error}`;
    throw new RangeError(`maxEvidenceBytes is too small to preserve scenario identity and cleanup evidence. ${cleanup}`);
  }
  return fallback;
}
