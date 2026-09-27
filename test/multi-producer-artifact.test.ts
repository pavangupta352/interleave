import { describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { missingReplayIdentity } from '../src/replay-readiness.js';
import { planFromTrace } from '../src/lanes.js';
import type { RunResult } from '../src/types.js';

const print = (character: string): string => character.repeat(64);
const transport = { version: 1, frontend: 'loopback-plaintext-v1', authentication: 'passthrough-no-channel-binding-v1', upstream: { profile: 'plaintext-v1' } };
function command(index: number, actor: string, connection: number, ordinal: number, sql: string, backendPid: number, available: string[]) {
  return { index, actor, connection, ordinal, protocol: 'simple', sql, fingerprint: print('b'), backendPid, available,
    releasedAt: index, completedAt: index + 0.5, completion: { transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 }, waits: [] as unknown[] };
}
/** alice uses two command connections, the second waiting for the first; bob uses one. */
function run(): Record<string, any> {
  return {
    schemaVersion: 4, scenario: 'pooled lanes', outcome: 'passed', mode: 'explore', plan: ['alice#0', 'alice#1', 'bob'],
    connections: [
      { actor: 'alice', connection: 0, fingerprint: print('a') }, { actor: 'alice', connection: 1, fingerprint: print('a') },
      { actor: 'bob', connection: 0, fingerprint: print('c') },
    ],
    trace: [
      command(0, 'alice', 0, 0, 'BEGIN; UPDATE t SET v = 1', 101, ['alice#0', 'alice#1', 'bob#0']),
      { ...command(1, 'alice', 1, 0, 'UPDATE t SET v = 2', 102, ['alice#1', 'bob#0']),
        waits: [{ pid: 102, blockerPids: [101], waitEvent: 'transactionid', waitEventType: 'Lock' }] },
      command(2, 'bob', 0, 0, 'SELECT 1', 103, ['bob#0']),
      command(3, 'alice', 0, 1, 'COMMIT', 101, ['alice#0']),
    ],
    actors: [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled', value: 1 }],
    environment: { serverVersion: '16.15', nodeVersion: 'v24.7.0', transport,
      fixture: { version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256', fingerprint: print('d'),
        components: { schema: print('d'), data: print('d'), sequences: print('d'), settings: print('d') }, counts: { objects: 1, rows: 1, bytes: 1 } } },
    startedAt: '2026-09-27T00:00:00.000Z', durationMs: 10,
    limits: { maxSteps: 100, timeoutMs: 10_000, maxEvidenceBytes: 8 * 1024 * 1024, maxConnectionsPerActor: 8,
      protocolProfile: 'sync-cycle-v1', connectionProfile: 'multi-producer-v1' },
    cleanup: { complete: true },
  };
}

describe('version 4 multi-producer artifacts', () => {
  test('preserve lanes, intra-actor waits and exact JSON bytes', () => {
    const original = run();
    expect(parseRunArtifact(original)).toBe(original);
    const serialized = JSON.stringify(original);
    expect(JSON.stringify(parseRunArtifact(serialized))).toBe(serialized);
    expect(missingReplayIdentity(original as RunResult)).toBeUndefined();
    expect(planFromTrace(original as RunResult)).toEqual(['alice#0', 'alice#1', 'bob', 'alice#0']);
  });

  test('accept interrupted evidence whose requested lane was never admitted', () => {
    const original = run();
    Object.assign(original, { outcome: 'incompatible', reason: 'Schedule asks for alice#5 at step 0', plan: ['alice#5'], trace: [], actors: [] });
    expect(parseRunArtifact(original)).toBe(original);
  });

  test('accept staged cycles open on two lanes of one actor', () => {
    const original = run();
    original.limits.protocolProfile = 'describe-flush-v1';
    const metadata = { kind: 'metadata', result: 'described', parameterCount: 0, columnCount: 1, resultShape: 'rows' };
    const ready = { kind: 'ready', transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 };
    const staged = (index: number, connection: number, backendPid: number, stage: string, ordinal: number, completion: object) => ({
      ...command(index, 'alice', connection, ordinal, 'SELECT 1', backendPid, [`alice#${connection}`]), protocol: 'extended', stage, cycle: 0,
      ...(stage === 'execute' ? { prefixOrdinal: 0 } : {}), completion });
    original.trace = [staged(0, 0, 101, 'describe', 0, metadata), staged(1, 1, 102, 'describe', 0, metadata),
      staged(2, 0, 101, 'execute', 1, ready), staged(3, 1, 102, 'execute', 1, ready)];
    original.plan = [];
    expect(parseRunArtifact(original)).toBe(original);
    const legacy = structuredClone(original);
    legacy.schemaVersion = 3;
    delete legacy.limits.connectionProfile;
    legacy.trace.forEach((step: any) => { step.available = ['alice']; });
    expect(() => parseRunArtifact(legacy)).toThrow(/open staged cycle/);
  });

  test.each([
    ['missing connection profile', (r: any) => { delete r.limits.connectionProfile; }, /connectionProfile: required/],
    ['single-producer profile without overlap', (r: any) => { r.limits.connectionProfile = 'single-producer-v1'; }, /single-producer record requires overlap pairs; use version 3/],
    ['unknown connection profile', (r: any) => { r.limits.connectionProfile = 'pooled-v1'; }, /connectionProfile: expected one of single-producer-v1, multi-producer-v1/],
    ['unknown overlap mode', (r: any) => { r.limits.overlap = 'triples'; }, /overlap: expected one of pairs/],
    ['pair plan without overlap', (r: any) => { r.plan = ['alice#0+bob#0']; }, /expected an actor connection lane|invalid actor id/],
    ['step overlap without overlap mode', (r: any) => { r.trace[0].overlap = 0; }, /overlap: unknown field/],
    ['unknown profile', (r: any) => { r.limits.connectionProfile = 'pool'; }, /connectionProfile/],
    ['missing connection limit', (r: any) => { delete r.limits.maxConnectionsPerActor; }, /maxConnectionsPerActor: required/],
    ['unknown limits field', (r: any) => { r.limits.lanes = 2; }, /unknown field/],
    ['missing startup identities', (r: any) => { delete r.connections; }, /connections: required/],
    ['missing transport', (r: any) => { delete r.environment.transport; }, /transport: required/],
    ['bare actor available', (r: any) => { r.trace[2].available = ['bob']; }, /expected an actor connection lane/],
    ['unrecorded available lane', (r: any) => { r.trace[2].available = ['bob#0', 'bob#7']; }, /available\[1\]: lane references an unrecorded actor startup/],
    ['selected lane absent', (r: any) => { r.trace[1].available = ['alice#0', 'bob#0']; }, /must include selected lane alice#1/],
    ['duplicate available lanes', (r: any) => { r.trace[2].available = ['bob#0', 'bob#0']; }, /duplicate lanes/],
    ['padded generation', (r: any) => { r.trace[2].available = ['bob#00']; }, /expected an actor connection lane/],
    ['prototype actor lane', (r: any) => { r.trace[2].available = ['bob#0', 'constructor#0']; }, /invalid actor id/],
    ['unrecorded plan lane after completion', (r: any) => { r.plan = ['alice#2']; }, /plan\[0\]: lane references an unrecorded actor startup/],
    ['malformed plan lane', (r: any) => { r.plan = ['alice#x']; }, /plan\[0\]/],
    ['blocker on its own lane', (r: any) => { r.trace[1].waits[0].blockerPids = [102]; }, /cannot block itself/],
    ['blocker absent from trace', (r: any) => { r.trace[1].waits[0].blockerPids = [999]; }, /absent from the released trace/],
    ['too many available lanes', (r: any) => { r.trace[2].available = Array.from({ length: 65 }, (_, index) => `bob#${index}`); }, /65|64 item limit/],
    ['unsupported version', (r: any) => { r.schemaVersion = 5; }, /expected 1, 2, 3 or 4/],
  ])('reject %s', (_name, mutate, message) => {
    const original = run(); mutate(original);
    expect(() => parseRunArtifact(original)).toThrow(message);
  });
});

describe('versions 1-3 keep their single-producer grammar', () => {
  function legacy(version: 1 | 3): Record<string, any> {
    const original = run();
    original.schemaVersion = version;
    delete original.limits.connectionProfile;
    original.plan = ['alice', 'alice', 'bob'];
    for (const step of original.trace) step.available = [step.actor];
    original.trace[1].connection = 0; original.trace[1].ordinal = 1; original.trace[3].ordinal = 2;
    original.trace[1].backendPid = 101; original.trace[1].waits = [];
    original.connections = original.connections.filter((item: any) => !(item.actor === 'alice' && item.connection === 1));
    if (version === 1) { delete original.environment.transport; delete original.limits.protocolProfile; }
    return original;
  }

  test('version 3 reads unchanged and rejects version 4 fields', () => {
    const original = legacy(3);
    expect(parseRunArtifact(original)).toBe(original);
    for (const mutate of [
      (r: any) => { r.limits.connectionProfile = 'multi-producer-v1'; },
      (r: any) => { r.plan = ['alice#0']; },
      (r: any) => { r.trace[0].available = ['alice#0']; },
    ]) {
      const changed = legacy(3); mutate(changed);
      expect(() => parseRunArtifact(changed)).toThrow(/unknown field|invalid actor id/);
    }
  });

  test('a same-actor blocker remains invalid before version 4', () => {
    const original = legacy(3);
    original.connections.push({ actor: 'alice', connection: 1, fingerprint: print('a') });
    original.trace[1] = { ...original.trace[1], connection: 1, ordinal: 0, backendPid: 102,
      waits: [{ pid: 102, blockerPids: [101], waitEvent: 'transactionid', waitEventType: 'Lock' }] };
    original.trace[3].ordinal = 1;
    expect(() => parseRunArtifact(original)).toThrow(/blocker pid must belong to a different actor/);
  });

  test('version 1 remains readable without explicit profiles', () => {
    const original = legacy(1);
    const serialized = JSON.stringify(original);
    expect(JSON.stringify(parseRunArtifact(serialized))).toBe(serialized);
    expect(planFromTrace(original as RunResult)).toEqual(['alice', 'alice', 'bob', 'alice']);
  });
});
