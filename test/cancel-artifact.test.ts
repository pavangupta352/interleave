import { describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { finalizeRunEvidence } from '../src/evidence.js';
import type { RunResult } from '../src/types.js';

const print = (character: string): string => character.repeat(64);
const transport = { version: 1, frontend: 'loopback-plaintext-v1', authentication: 'passthrough-no-channel-binding-v1', upstream: { profile: 'plaintext-v1' } };
const cancelled = { transactionStatus: 'I', commandTags: [], rowCount: 0, error: { code: '57014', message: 'canceling statement due to user request' } };
/** alice's sleep is cancelled while it runs; bob then names a backend that is not his. */
function run(): Record<string, any> {
  return {
    schemaVersion: 5, scenario: 'cancel a sleeping statement', outcome: 'passed', mode: 'explore', plan: [],
    connections: [{ actor: 'alice', connection: 0, fingerprint: print('a') }, { actor: 'bob', connection: 0, fingerprint: print('c') }],
    trace: [
      { index: 0, actor: 'alice', connection: 0, ordinal: 0, protocol: 'simple', sql: 'SELECT pg_sleep(30)', fingerprint: print('b'),
        backendPid: 101, available: ['alice', 'bob'], releasedAt: 1, completedAt: 5, completion: cancelled, waits: [] },
      { index: 1, actor: 'bob', connection: 0, ordinal: 0, protocol: 'simple', sql: 'SELECT 1', fingerprint: print('e'),
        backendPid: 102, available: ['bob'], releasedAt: 6, completedAt: 7, completion: { transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 }, waits: [] },
    ],
    cancels: [
      { at: 3, actor: 'alice', backendPid: 101, forwarded: true, connection: 0, step: 0 },
      { at: 8, actor: 'bob', backendPid: 1, forwarded: false },
    ],
    actors: [{ actor: 'alice', status: 'fulfilled', value: '57014' }, { actor: 'bob', status: 'fulfilled' }],
    environment: { serverVersion: '16.15', nodeVersion: 'v24.7.0', transport,
      fixture: { version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256', fingerprint: print('d'),
        components: { schema: print('d'), data: print('d'), sequences: print('d'), settings: print('d') }, counts: { objects: 1, rows: 1, bytes: 1 } } },
    startedAt: '2026-10-25T00:00:00.000Z', durationMs: 10,
    limits: { maxSteps: 100, timeoutMs: 10_000, maxEvidenceBytes: 8 * 1024 * 1024, maxConnectionsPerActor: 1,
      protocolProfile: 'sync-cycle-v1', connectionProfile: 'single-producer-v1' },
    cleanup: { complete: true },
  };
}

describe('version 5 cancel request artifacts', () => {
  test('preserve forwarded and rejected requests and exact JSON bytes', () => {
    const original = run();
    expect(parseRunArtifact(original)).toBe(original);
    const serialized = JSON.stringify(original);
    expect(JSON.stringify(parseRunArtifact(serialized))).toBe(serialized);
  });

  test('accept a request that found its backend idle and a multi-producer record', () => {
    const idle = run(); delete idle.cancels[0].step; idle.cancels[0].at = 0.5;
    expect(parseRunArtifact(idle)).toBe(idle);
    const lanes = run(); lanes.limits.connectionProfile = 'multi-producer-v1'; lanes.limits.maxConnectionsPerActor = 8;
    lanes.trace[0].available = ['alice#0', 'bob#0']; lanes.trace[1].available = ['bob#0'];
    expect(parseRunArtifact(lanes)).toBe(lanes);
  });

  test.each([
    ['version 5 without cancels or COPY', (r: any) => { delete r.cancels; }, /^\$: a version 5 record uses flush-stages-v1 or has at least one cancel request or COPY transfer; use version 3 or 4$/],
    ['an empty list', (r: any) => { r.cancels = []; }, /\$\.cancels: omit cancels when no cancel request arrived/],
    ['cancels before version 5', (r: any) => { r.schemaVersion = 3; delete r.limits.connectionProfile; }, /\$\.cancels: cancel requests require version 5/],
    ['a missing connection profile', (r: any) => { delete r.limits.connectionProfile; }, /\$\.limits\.connectionProfile: required field is missing/],
    ['a forwarded request without its connection', (r: any) => { delete r.cancels[0].connection; }, /cancels\[0\]\.connection: present exactly when the request was forwarded/],
    ['a rejected request with a connection', (r: any) => { r.cancels[1].connection = 0; }, /cancels\[1\]\.connection: present exactly when the request was forwarded/],
    ['an unrecorded connection', (r: any) => { r.cancels[0].connection = 3; }, /cancels\[0\]\.connection: references an unrecorded actor startup/],
    ['another connection\'s backend', (r: any) => { r.cancels[0].backendPid = 102; }, /cancels\[0\]\.backendPid: differs from the backend of that connection/],
    ['a step on another connection', (r: any) => { r.cancels[0].step = 1; }, /cancels\[0\]\.step: the step ran on a different connection/],
    ['a step that had completed', (r: any) => { r.cancels[0].at = 6; }, /cancels\[0\]\.step: the step was not running when the request arrived/],
    ['a step not yet released', (r: any) => { r.cancels[0].at = 0.5; }, /cancels\[0\]\.step: the step was not running when the request arrived/],
    ['a step absent from the trace', (r: any) => { r.cancels[0].step = 9; }, /cancels\[0\]\.step: references a step absent from the trace/],
    ['a rejected request that hit a step', (r: any) => { r.cancels[1].step = 1; }, /cancels\[1\]\.step: a request that was not forwarded cannot hit a step/],
    ['arrivals out of order', (r: any) => { r.cancels[1].at = 2; }, /cancels\[1\]\.at: arrival times must be nondecreasing/],
    ['an arrival after the run', (r: any) => { r.cancels[1].at = 11; }, /cancels\[1\]\.at: cannot exceed run durationMs/],
    ['a recorded secret key', (r: any) => { r.cancels[0].secretKey = 7; }, /secretKey/],
    ['a process ID wider than 32 bits', (r: any) => { r.cancels[1].backendPid = 2 ** 31; }, /cancels\[1\]\.backendPid: expected a 32-bit process ID/],
    ['an actor without a result', (r: any) => { r.cancels[1].actor = 'carol'; }, /cancels\[1\]\.actor: actor is absent from recorded actor results/],
    ['a forwarded request without the step that was running', (r: any) => { delete r.cancels[0].step; }, /cancels\[0\]\.step: a step of that connection was running when the request arrived/],
    ['a forwarded request for no backend', (r: any) => { r.trace[0].backendPid = 0; r.cancels[0].backendPid = 0; delete r.cancels[0].step; r.cancels[0].at = 0.5; }, /backendPid/],
  ])('reject %s', (_name, mutate, message) => {
    const original = run(); mutate(original);
    expect(() => parseRunArtifact(original)).toThrow(message);
  });

  test.each([
    ['single-producer', 'single-producer-v1', 3],
    ['multi-producer', 'multi-producer-v1', 4],
  ] as const)('incomplete %s evidence drops cancel requests with the trace they reference', (_name, profile, version) => {
    const original = run();
    if (profile === 'multi-producer-v1') {
      original.limits.connectionProfile = profile; original.limits.maxConnectionsPerActor = 8;
      original.trace[0].available = ['alice#0', 'bob#0']; original.trace[1].available = ['bob#0'];
    }
    const fallback = finalizeRunEvidence(original as RunResult, JSON.stringify(original).length - 1);
    expect(fallback.outcome).toBe('inconclusive');
    expect(fallback.schemaVersion).toBe(version);
    expect(fallback.cancels).toBeUndefined();
    expect(fallback.trace).toEqual([]);
    expect(fallback.limits.connectionProfile).toBe(version === 4 ? profile : undefined);
  });
});
