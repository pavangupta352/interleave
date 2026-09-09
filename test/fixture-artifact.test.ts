import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import type { RunResult } from '../src/types.js';
const artifact = (): RunResult => ({
  schemaVersion: 1, scenario: 'fixture metadata', mode: 'explore', outcome: 'passed', plan: [], trace: [],
  actors: [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled' }],
  environment: { serverVersion: '16.13', nodeVersion: 'v24.7.0', fixture: {
    version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256', fingerprint: 'a'.repeat(64),
    components: { schema: 'b'.repeat(64), data: 'c'.repeat(64), sequences: 'd'.repeat(64), settings: 'e'.repeat(64) },
    counts: { objects: 1, rows: 0, bytes: 300 },
  } },
  startedAt: '2026-09-09T00:00:00.000Z', durationMs: 1, limits: { maxSteps: 100, timeoutMs: 10000 }, cleanup: { complete: true },
});
test('fixture identity survives strict object and JSON artifact validation', () => {
  const run = artifact(); expect(parseRunArtifact(run)).toEqual(run); expect(parseRunArtifact(JSON.stringify(run))).toEqual(run);
});
test.each([
  ['version', 2], ['profile', 'unknown-profile'], ['algorithm', 'md5'], ['fingerprint', 'not-a-hash'],
  ['components', { schema: 'a'.repeat(64), data: 'a'.repeat(64), sequences: 'a'.repeat(64), settings: 'a'.repeat(64), hidden: true }],
  ['counts', { objects: 1, rows: -1, bytes: 300 }], ['counts', { objects: 1, rows: 0, bytes: Infinity }],
  ['unrecognized', true],
])('rejects invalid or unrecognized fixture metadata: %s', (key, value) => {
  const run = artifact(); (run.environment.fixture as unknown as Record<string, unknown>)[key] = value;
  expect(() => parseRunArtifact(run)).toThrow();
});
