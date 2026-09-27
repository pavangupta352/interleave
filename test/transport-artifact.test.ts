import { describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { environmentMatches } from '../src/environment.js';
import { missingReplayIdentity } from '../src/replay-readiness.js';
import { runOnce } from '../src/runner.js';
import type { RunResult } from '../src/types.js';

const fingerprint = 'a'.repeat(64);
function transport(tls = false) {
  return { version: 1, frontend: 'loopback-plaintext-v1', authentication: 'passthrough-no-channel-binding-v1',
    upstream: tls ? { profile: 'tls-verify-full-v1', negotiation: 'postgres-sslrequest-v1', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
      trustSource: 'custom-ca', trustFingerprint: 'b'.repeat(64), referenceFingerprint: 'c'.repeat(64) } : { profile: 'plaintext-v1' } };
}
function run(tls = false): Record<string, any> {
  return {
    schemaVersion: 3, scenario: 'transport contract', outcome: 'passed', mode: 'explore', plan: [],
    connections: [{ actor: 'alice', connection: 0, fingerprint }],
    trace: [{ index: 0, actor: 'alice', connection: 0, ordinal: 0, protocol: 'simple', sql: 'SELECT 7', fingerprint,
      backendPid: 101, available: ['alice'], releasedAt: 0, completedAt: 1,
      completion: { transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 }, waits: [] }],
    actors: [{ actor: 'alice', status: 'fulfilled', value: 7 }, { actor: 'bob', status: 'fulfilled' }],
    environment: { serverVersion: '16.15', nodeVersion: 'v22.18.0', transport: transport(tls),
      fixture: { version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256', fingerprint,
        components: { schema: fingerprint, data: fingerprint, sequences: fingerprint, settings: fingerprint }, counts: { objects: 0, rows: 0, bytes: 0 } } },
    startedAt: '2026-09-25T00:00:00.000Z', durationMs: 1,
    limits: { maxSteps: 100, timeoutMs: 1000, protocolProfile: 'sync-cycle-v1' }, cleanup: { complete: true },
  };
}

describe('version 3 transport evidence', () => {
  test.each([false, true])('preserves ordinary result evidence with TLS=%s and independent protocol identity', tls => {
    const original = run(tls);
    expect(parseRunArtifact(original)).toBe(original);
    expect(JSON.stringify(parseRunArtifact(JSON.stringify(original)))).toBe(JSON.stringify(original));
    expect(original.trace[0]).not.toHaveProperty('stage');
  });
  test.each(['inconclusive', 'incompatible', 'harness-error'])('preserves explicit selected policy before startup for %s', outcome => {
    const original = run(true); original.outcome = outcome; original.trace = []; original.connections = []; original.actors = [];
    original.environment.serverVersion = 'unknown'; delete original.environment.fixture;
    expect(parseRunArtifact(original)).toBe(original);
  });
  test.each([
    ['missing transport', (r: any) => { delete r.environment.transport; }],
    ['missing protocol profile', (r: any) => { delete r.limits.protocolProfile; }],
    ['unknown protocol profile', (r: any) => { r.limits.protocolProfile = 'auto'; }],
    ['missing startup identities', (r: any) => { delete r.connections; }],
    ['ordinary trace with staged protocol', (r: any) => { r.limits.protocolProfile = 'describe-flush-v1'; }],
    ['staged field in ordinary protocol', (r: any) => { r.trace[0].stage = 'complete'; }],
    ['metadata completion in ordinary protocol', (r: any) => { r.trace[0].completion = { kind: 'metadata', result: 'described', parameterCount: 0, columnCount: 0, resultShape: 'no-data' }; }],
    ['unsupported wrapper version', (r: any) => { r.environment.transport.version = 2; }],
    ['unsupported frontend', (r: any) => { r.environment.transport.frontend = 'tls'; }],
    ['channel binding claim', (r: any) => { r.environment.transport.authentication = 'scram-plus'; }],
    ['missing authentication', (r: any) => { delete r.environment.transport.authentication; }],
    ['missing upstream', (r: any) => { delete r.environment.transport.upstream; }],
    ['unknown upstream profile', (r: any) => { r.environment.transport.upstream.profile = 'tls-no-verify'; }],
    ['direct TLS negotiation', (r: any) => { r.environment.transport.upstream.negotiation = 'direct'; }],
    ['lower TLS minimum', (r: any) => { r.environment.transport.upstream.minVersion = 'TLSv1.1'; }],
    ['unknown TLS maximum', (r: any) => { r.environment.transport.upstream.maxVersion = 'TLSv1.4'; }],
    ['ambient trust', (r: any) => { r.environment.transport.upstream.trustSource = 'system'; }],
    ['missing trust identity', (r: any) => { delete r.environment.transport.upstream.trustFingerprint; }],
    ['short name fingerprint', (r: any) => { r.environment.transport.upstream.referenceFingerprint = 'c'.repeat(63); }],
    ['uppercase trust fingerprint', (r: any) => { r.environment.transport.upstream.trustFingerprint = 'A'.repeat(64); }],
    ['oversized reference fingerprint', (r: any) => { r.environment.transport.upstream.referenceFingerprint = 'c'.repeat(65_537); }],
    ['hostname disclosure', (r: any) => { r.environment.transport.upstream.hostname = 'private.example'; }],
    ['raw CA disclosure', (r: any) => { r.environment.transport.upstream.ca = '-----BEGIN CERTIFICATE-----'; }],
    ['private path disclosure', (r: any) => { r.environment.transport.caPath = '/private/ca.pem'; }],
    ['unknown environment field', (r: any) => { r.environment.url = 'postgresql://private'; }],
    ['plaintext with TLS details', (r: any) => { r.environment.transport.upstream.profile = 'plaintext-v1'; }],
    ['SQL bound', (r: any) => { r.trace[0].sql = 'x'.repeat(1_048_577); }],
    ['evidence limit', (r: any) => { r.limits.maxEvidenceBytes = 12 * 1024 * 1024 + 1; }],
  ])('rejects %s', (_name, mutate) => {
    const original = run(true); mutate(original);
    expect(() => parseRunArtifact(original)).toThrow();
  });
  test('accepts bundled trust and rejects missing TLS details', () => {
    const original = run(true); original.environment.transport.upstream.trustSource = 'node-bundled';
    expect(parseRunArtifact(original)).toBe(original);
    delete original.environment.transport.upstream.negotiation;
    expect(() => parseRunArtifact(original)).toThrow(/negotiation/);
  });
  test('rejects prototype pollution and accessors without evaluating them', () => {
    const original = run(true);
    const serialized = JSON.stringify(original).replace('"upstream":{', '"upstream":{"__proto__":{},');
    expect(() => parseRunArtifact(serialized)).toThrow(/prototype|forbidden/);
    let read = false;
    Object.defineProperty(original.environment.transport, 'upstream', { enumerable: true, get() { read = true; throw Error('getter ran'); } });
    expect(() => parseRunArtifact(original)).toThrow(/data property/); expect(read).toBe(false);
  });
  test('legacy ordinary bytes remain readable without inferred transport or new fields', () => {
    const original = run(); original.schemaVersion = 1; delete original.environment.transport; delete original.limits.protocolProfile;
    const serialized = JSON.stringify(original);
    expect(JSON.stringify(parseRunArtifact(serialized))).toBe(serialized);
    original.environment.transport = transport();
    expect(() => parseRunArtifact(original)).toThrow(/unknown/);
  });
});

describe('transport replay boundary', () => {
  test('requires guided migration for a legacy run even with fixture and startup identities', async () => {
    const original = run(); original.schemaVersion = 1; delete original.environment.transport; delete original.limits.protocolProfile;
    const legacy = parseRunArtifact(original);
    expect(missingReplayIdentity(legacy)).toMatch(/transport.*guided/i);
    let setup = false;
    // An unreachable URL is intentional: replay identity rejection must occur before
    // database creation or networking, not after a connection failure.
    const result = await runOnce({ name: original.scenario, async setup() { setup = true; },
      actors: { async alice() {}, async bob() {} }, async invariant() {} },
    { databaseUrl: 'postgresql://interleave.invalid:9/unused', replay: legacy, mode: 'replay' });
    expect(result.outcome).toBe('incompatible'); expect(result.reason).toMatch(/transport.*guided/i);
    expect(result.trace).toEqual([]); expect(result.cleanup.complete).toBe(true); expect(setup).toBe(false);
  });
  test('accepts complete new replay identity but still requires fixture and startup identities', () => {
    const original = run() as unknown as RunResult;
    expect(missingReplayIdentity(original)).toBeUndefined();
    delete original.environment.fixture; expect(missingReplayIdentity(original)).toMatch(/fixture/);
    delete original.connections; expect(missingReplayIdentity(original)).toMatch(/connection/);
  });
  test('compares every recorded transport field independently of object key order', () => {
    const expected = run(true).environment as RunResult['environment'];
    const matching = structuredClone(expected); const upstream = matching.transport!.upstream;
    matching.transport!.upstream = Object.fromEntries(Object.entries(upstream).reverse()) as typeof upstream;
    expect(environmentMatches(expected, matching)).toBe(true);
    for (const [key, value] of Object.entries({ version: 2, frontend: 'other', authentication: 'other' })) {
      const changed = structuredClone(expected); (changed.transport as any)[key] = value;
      expect(environmentMatches(expected, changed), key).toBe(false);
    }
    for (const [key, value] of Object.entries({ profile: 'plaintext-v1', negotiation: 'direct', minVersion: 'TLSv1.1', maxVersion: 'TLSv1.2',
      trustSource: 'node-bundled', trustFingerprint: 'd'.repeat(64), referenceFingerprint: 'e'.repeat(64) })) {
      const changed = structuredClone(expected); (changed.transport!.upstream as any)[key] = value;
      expect(environmentMatches(expected, changed), key).toBe(false);
    }
    const missing = structuredClone(expected); delete missing.transport;
    expect(environmentMatches(expected, missing)).toBe(false);
    expect(environmentMatches(run().environment, expected)).toBe(false);
  });
  test('retains fixture/source/runtime equality and legacy comparison semantics', () => {
    const expected = run().environment as RunResult['environment'];
    for (const key of ['serverVersion', 'nodeVersion'] as const) {
      const changed = structuredClone(expected); changed[key] = 'changed'; expect(environmentMatches(expected, changed)).toBe(false);
    }
    const fixture = structuredClone(expected); fixture.fixture!.fingerprint = 'd'.repeat(64); expect(environmentMatches(expected, fixture)).toBe(false);
    const noFixture = structuredClone(expected); delete noFixture.fixture; expect(environmentMatches(expected, noFixture)).toBe(false);
    const source = structuredClone(expected); source.source = { fingerprint: 'e'.repeat(64) } as NonNullable<RunResult['environment']['source']>;
    expect(environmentMatches(expected, source)).toBe(false);
    expect(environmentMatches(source, expected)).toBe(false);
    const changedSource = structuredClone(source); changedSource.source!.fingerprint = 'f'.repeat(64); expect(environmentMatches(source, changedSource)).toBe(false);
    const legacy = structuredClone(expected); delete legacy.transport;
    expect(environmentMatches(legacy, expected)).toBe(true);
  });
});
