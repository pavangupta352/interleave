import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { finalizeRunEvidence } from '../src/evidence.js';
import type { RunResult } from '../src/types.js';

const print = (character: string): string => character.repeat(64);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const transport = { version: 1, frontend: 'loopback-plaintext-v1', authentication: 'passthrough-no-channel-binding-v1', upstream: { profile: 'plaintext-v1' } };
/** alice copies two rows in and reads them back out. */
function run(): Record<string, any> {
  const data = '1\tapple\n2\tpear\n';
  const step = (index: number, sql: string, direction: 'in' | 'out') => ({
    index, actor: 'alice', connection: 0, ordinal: index, protocol: 'simple', sql, fingerprint: print('b'), backendPid: 101,
    available: ['alice', 'bob'], releasedAt: index + 1, completedAt: index + 1.5,
    completion: { transactionStatus: 'I', commandTags: ['COPY 2'], rowCount: 2, copy: [{ direction, bytes: 15, sha256: sha256(data) }] }, waits: [],
  });
  return {
    schemaVersion: 5, scenario: 'copy in and out', outcome: 'passed', mode: 'explore', plan: [],
    connections: [{ actor: 'alice', connection: 0, fingerprint: print('a') }],
    trace: [step(0, 'COPY items FROM STDIN', 'in'), step(1, 'COPY items TO STDOUT', 'out')],
    actors: [{ actor: 'alice', status: 'fulfilled', value: data }, { actor: 'bob', status: 'fulfilled' }],
    environment: { serverVersion: '16.15', nodeVersion: 'v24.7.0', transport,
      fixture: { version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256', fingerprint: print('d'),
        components: { schema: print('d'), data: print('d'), sequences: print('d'), settings: print('d') }, counts: { objects: 1, rows: 0, bytes: 1 } } },
    startedAt: '2026-10-25T00:00:00.000Z', durationMs: 10,
    limits: { maxSteps: 100, timeoutMs: 10_000, maxEvidenceBytes: 8 * 1024 * 1024, maxConnectionsPerActor: 1,
      protocolProfile: 'sync-cycle-v1', connectionProfile: 'single-producer-v1' },
    cleanup: { complete: true },
  };
}

describe('version 5 COPY transfer artifacts', () => {
  test('preserve both directions and exact JSON bytes without cancel requests', () => {
    const original = run();
    expect(parseRunArtifact(original)).toBe(original);
    const serialized = JSON.stringify(original);
    expect(JSON.stringify(parseRunArtifact(serialized))).toBe(serialized);
  });

  test('accept an empty copy and several copies in one command', () => {
    const original = run();
    original.trace[0].completion.copy = [{ direction: 'in', bytes: 0, sha256: sha256('') }, { direction: 'in', bytes: 3, sha256: sha256('3\t\n') }];
    expect(parseRunArtifact(original)).toBe(original);
  });

  test.each([
    ['COPY before version 5', (r: any) => { r.schemaVersion = 3; delete r.limits.connectionProfile; }, /\$\.trace\[0\]\.completion: unexpected field copy|copy/],
    ['an empty transfer list', (r: any) => { r.trace[0].completion.copy = []; }, /omit copy when the command moved no COPY data/],
    ['an unknown direction', (r: any) => { r.trace[0].completion.copy[0].direction = 'both'; }, /copy\[0\]\.direction/],
    ['a negative byte count', (r: any) => { r.trace[0].completion.copy[0].bytes = -1; }, /copy\[0\]\.bytes/],
    ['a malformed digest', (r: any) => { r.trace[0].completion.copy[0].sha256 = 'abc'; }, /copy\[0\]\.sha256/],
    ['an empty digest for data', (r: any) => { r.trace[0].completion.copy[0].sha256 = sha256(''); }, /copy\[0\]\.sha256: contradicts the byte count/],
    ['data digest for no bytes', (r: any) => { r.trace[0].completion.copy[0].bytes = 0; }, /copy\[0\]\.sha256: contradicts the byte count/],
    ['an extra transfer field', (r: any) => { r.trace[0].completion.copy[0].rows = 2; }, /rows/],
    ['version 5 without COPY or cancels', (r: any) => { for (const step of r.trace) delete step.completion.copy; }, /^\$: a version 5 record uses flush-stages-v1 or has at least one cancel request or COPY transfer/],
  ])('reject %s', (_name, mutate, message) => {
    const original = run(); mutate(original);
    expect(() => parseRunArtifact(original)).toThrow(message);
  });

  test('incomplete evidence drops COPY transfers with the trace that holds them', () => {
    const original = run();
    const fallback = finalizeRunEvidence(original as RunResult, JSON.stringify(original).length - 1);
    expect(fallback.outcome).toBe('inconclusive');
    expect(fallback.schemaVersion).toBe(3);
    expect(fallback.trace).toEqual([]);
    expect(fallback.limits.connectionProfile).toBeUndefined();
  });
});
