import type { RunResult, RunTransportIdentity } from './types.js';

/** Compare starting conditions independently of actor order or query identity. */
export function environmentMatches(expected: RunResult['environment'], actual: RunResult['environment']): boolean {
  const fixture = expected.fixture;
  const captured = actual.fixture;
  return expected.serverVersion === actual.serverVersion
    && expected.nodeVersion === actual.nodeVersion
    && (expected.source === undefined ? actual.source === undefined : expected.source.fingerprint === actual.source?.fingerprint)
    && (expected.transport === undefined || transportMatches(expected.transport, actual.transport))
    && fixture !== undefined && captured !== undefined
    && fixture.version === captured.version
    && fixture.profile === captured.profile
    && fixture.algorithm === captured.algorithm
    && fixture.fingerprint === captured.fingerprint;
}

export function transportMatches(expected: RunTransportIdentity, actual: RunTransportIdentity | undefined): boolean {
  if (!actual || expected.version !== actual.version || expected.frontend !== actual.frontend
    || expected.authentication !== actual.authentication) return false;
  const upstream = expected.upstream;
  const captured = actual.upstream;
  if (upstream.profile !== captured.profile) return false;
  if (upstream.profile === 'plaintext-v1') return true;
  return captured.profile === 'tls-verify-full-v1'
    && upstream.negotiation === captured.negotiation
    && upstream.minVersion === captured.minVersion
    && upstream.maxVersion === captured.maxVersion
    && upstream.trustSource === captured.trustSource
    && upstream.trustFingerprint === captured.trustFingerprint
    && upstream.referenceFingerprint === captured.referenceFingerprint;
}
