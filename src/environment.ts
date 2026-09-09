import type { RunResult } from './types.js';

/** Compare starting conditions independently of actor order or query identity. */
export function environmentMatches(expected: RunResult['environment'], actual: RunResult['environment']): boolean {
  const fixture = expected.fixture;
  const captured = actual.fixture;
  return expected.serverVersion === actual.serverVersion
    && expected.nodeVersion === actual.nodeVersion
    && (expected.source === undefined ? actual.source === undefined : expected.source.fingerprint === actual.source?.fingerprint)
    && fixture !== undefined && captured !== undefined
    && fixture.version === captured.version
    && fixture.profile === captured.profile
    && fixture.algorithm === captured.algorithm
    && fixture.fingerprint === captured.fingerprint;
}
