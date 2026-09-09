import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { captureSourceIdentity, type SourceIdentity } from '../src/source-identity.js';

const digest = (character: string) => character.repeat(64);
function sourceIdentity(): SourceIdentity {
  const applicationPackage = {
    id: 'p0', name: 'driver', version: '1.0.0', fingerprint: digest('d'),
    files: [{ path: 'package.json', bytes: 20, sha256: digest('e') }],
    fileCount: 1, byteCount: 20, dependencies: [],
  };
  const runtimePackage = structuredClone(applicationPackage);
  const dependencies = {
    fingerprint: digest('f'),
    roots: [{ name: 'driver', from: 'scenario.mjs', packageId: 'p0' }],
    packages: [applicationPackage], fileCount: 1, byteCount: 20,
  };
  const runtimeDependencies = {
    fingerprint: digest('1'), roots: [{ name: 'driver', packageId: 'p0' }],
    packages: [runtimePackage], fileCount: 1, byteCount: 20,
  };
  return {
    version: 1, profile: 'node-source-v1', algorithm: 'sha256', fingerprint: digest('a'),
    entry: 'scenario.mjs', includes: [],
    sharedPackages: [{ dependencyPackageId: 'p0', runtimePackageId: 'p0' }],
    components: {
      source: {
        fingerprint: digest('b'), files: [{ path: 'scenario.mjs', bytes: 10, sha256: digest('c') }],
        fileCount: 1, byteCount: 10,
      },
      dependencies,
      runtime: {
        mode: 'source', fingerprint: digest('2'),
        files: [{ path: 'package.json', bytes: 30, sha256: digest('3') }],
        fileCount: 2, byteCount: 50, dependencies: runtimeDependencies,
      },
    },
    fileCount: 4, byteCount: 80,
  };
}

function artifact(source: SourceIdentity = sourceIdentity()): Record<string, unknown> {
  return {
    schemaVersion: 1, scenario: 'source metadata', mode: 'explore', outcome: 'passed', plan: [], trace: [],
    actors: [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled' }],
    environment: { serverVersion: '18.6', nodeVersion: process.version, source },
    startedAt: '2026-09-09T00:00:00.000Z', durationMs: 1,
    limits: { maxSteps: 100, timeoutMs: 10_000 }, cleanup: { complete: true },
  };
}

let temporaryRoot: string | undefined;
afterAll(async () => { if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }); });

test('an actual captured source identity survives strict object and JSON artifact validation', async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'interleave source artifact '));
  await writeFile(join(temporaryRoot, 'scenario.mjs'), 'export default 42;');
  const captured = await captureSourceIdentity(join(temporaryRoot, 'scenario.mjs'));
  const run = artifact(captured);
  expect(parseRunArtifact(run).environment.source).toEqual(captured);
  expect(parseRunArtifact(JSON.stringify(run))).toEqual(run);
  expect(JSON.stringify(run)).not.toContain(temporaryRoot);
});

test('accepts the complete strict source identity graph', () => {
  const run = artifact();
  expect(parseRunArtifact(run)).toEqual(run);
});

test.each([
  ['source version', (source: Record<string, unknown>) => { source.version = 2; }],
  ['source profile', (source: Record<string, unknown>) => { source.profile = 'unknown-source'; }],
  ['algorithm', (source: Record<string, unknown>) => { source.algorithm = 'md5'; }],
  ['fingerprint', (source: Record<string, unknown>) => { source.fingerprint = 'A'.repeat(64); }],
  ['absolute entry', (source: Record<string, unknown>) => { source.entry = '/private/scenario.mjs'; }],
  ['URL entry', (source: Record<string, unknown>) => { source.entry = 'https://private.example/scenario.mjs'; }],
  ['traversing include', (source: Record<string, unknown>) => { source.includes = ['../private']; }],
  ['missing entry', (source: Record<string, unknown>) => { source.entry = 'missing.mjs'; }],
])('rejects invalid source identity metadata: %s', (_name, mutate) => {
  const run = artifact();
  mutate((run.environment as { source: Record<string, unknown> }).source);
  expect(() => parseRunArtifact(run)).toThrow();
});

test('rejects unknown fields and hostile prototypes throughout source identity', () => {
  const unknown = artifact();
  (unknown.environment as { source: Record<string, unknown> }).source.unrecognized = true;
  expect(() => parseRunArtifact(unknown)).toThrow(/unknown/i);

  const nested = artifact();
  const file = (((nested.environment as { source: SourceIdentity }).source.components.source.files[0]) as unknown as Record<string, unknown>);
  file.unrecognized = true;
  expect(() => parseRunArtifact(nested)).toThrow(/unknown/i);

  const hostile = artifact();
  Object.setPrototypeOf((hostile.environment as { source: object }).source, { polluted: true });
  expect(() => parseRunArtifact(hostile)).toThrow(/prototype|plain|JSON/i);
});

test.each([
  ['source file count', (value: SourceIdentity) => { value.components.source.fileCount = 2; }],
  ['source byte count', (value: SourceIdentity) => { value.components.source.byteCount = 11; }],
  ['package file count', (value: SourceIdentity) => { value.components.dependencies.packages[0]!.fileCount = 2; }],
  ['dependency graph byte count', (value: SourceIdentity) => { value.components.dependencies.byteCount = 21; }],
  ['runtime aggregate file count', (value: SourceIdentity) => { value.components.runtime.fileCount = 1; }],
  ['root aggregate byte count', (value: SourceIdentity) => { value.byteCount = 81; }],
])('rejects contradictory source identity counts: %s', (_name, mutate) => {
  const source = sourceIdentity(); mutate(source);
  expect(() => parseRunArtifact(artifact(source))).toThrow(/count|sum|total/i);
});

test('rejects dangling, duplicate, malformed, and contradictory dependency graph edges', () => {
  const dangling = sourceIdentity(); dangling.components.dependencies.roots[0]!.packageId = 'p9';
  expect(() => parseRunArtifact(artifact(dangling))).toThrow(/reference|package/i);

  const duplicate = sourceIdentity(); duplicate.components.dependencies.packages.push(structuredClone(duplicate.components.dependencies.packages[0]!));
  duplicate.components.dependencies.fileCount = 2; duplicate.components.dependencies.byteCount = 40;
  duplicate.fileCount = 5; duplicate.byteCount = 100;
  expect(() => parseRunArtifact(artifact(duplicate))).toThrow(/duplicate|package.*id/i);

  const missing = sourceIdentity();
  missing.components.dependencies.packages[0]!.dependencies = [{ name: 'optional', missing: true }];
  expect(() => parseRunArtifact(artifact(missing))).toThrow(/optional|missing/i);

  const both = sourceIdentity();
  both.components.dependencies.packages[0]!.dependencies = [{ name: 'optional', optional: true, missing: true, packageId: 'p0' }];
  expect(() => parseRunArtifact(artifact(both))).toThrow(/missing|package/i);

  const badFrom = sourceIdentity(); badFrom.components.dependencies.roots[0]!.from = 'not-in-source.mjs';
  expect(() => parseRunArtifact(artifact(badFrom))).toThrow(/from|source manifest/i);

  const duplicateEdge = sourceIdentity();
  duplicateEdge.components.dependencies.roots.push(structuredClone(duplicateEdge.components.dependencies.roots[0]!));
  expect(() => parseRunArtifact(artifact(duplicateEdge))).toThrow(/duplicate|unique|sorted/i);
});

test('rejects invalid shared-package references, duplicates, and unlike package mappings', () => {
  const dangling = sourceIdentity(); dangling.sharedPackages[0]!.runtimePackageId = 'p9';
  expect(() => parseRunArtifact(artifact(dangling))).toThrow(/shared|reference|package/i);

  const duplicate = sourceIdentity(); duplicate.sharedPackages.push(structuredClone(duplicate.sharedPackages[0]!));
  expect(() => parseRunArtifact(artifact(duplicate))).toThrow(/duplicate|shared/i);

  const unlike = sourceIdentity(); unlike.components.runtime.dependencies.packages[0]!.version = '2.0.0';
  expect(() => parseRunArtifact(artifact(unlike))).toThrow(/shared|same|version|package/i);
});

test('rejects duplicate or nonportable manifest paths and unordered includes', () => {
  const paths = sourceIdentity();
  paths.components.source.files.push({ path: 'scenario.mjs', bytes: 0, sha256: digest('4') });
  paths.components.source.fileCount = 2;
  expect(() => parseRunArtifact(artifact(paths))).toThrow(/duplicate|order|path/i);

  const windows = sourceIdentity(); windows.components.source.files[0]!.path = 'C:\\private\\scenario.mjs'; windows.entry = 'C:\\private\\scenario.mjs';
  expect(() => parseRunArtifact(artifact(windows))).toThrow(/path|portable|relative/i);

  const control = sourceIdentity(); control.components.source.files[0]!.path = 'private\nscenario.mjs'; control.entry = 'private\nscenario.mjs';
  expect(() => parseRunArtifact(artifact(control))).toThrow(/path|portable|relative/i);

  const includes = sourceIdentity(); includes.includes = ['z', 'a'];
  expect(() => parseRunArtifact(artifact(includes))).toThrow(/include|order/i);

  const oversized = sourceIdentity();
  oversized.components.source.files[0]!.bytes = 16 * 1024 * 1024 + 1;
  oversized.components.source.byteCount = oversized.components.source.files[0]!.bytes;
  oversized.byteCount = oversized.components.source.byteCount
    + oversized.components.dependencies.byteCount + oversized.components.runtime.byteCount;
  expect(() => parseRunArtifact(artifact(oversized))).toThrow(/byte limit|exceeds/i);
});
