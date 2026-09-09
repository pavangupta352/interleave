import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { exportRegression, verifyRegressionExport } from '../src/export.js';
import type { RunResult } from '../src/types.js';
import { bindExportFixture } from './helpers/export.js';

const roots: string[] = [];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'interleave-export-readiness-')); roots.push(root);
  const projectRoot = join(root, 'app'), runtimeRoot = join(root, 'runtime');
  await mkdir(projectRoot); await mkdir(join(runtimeRoot, 'dist'), { recursive: true });
  await json(join(projectRoot, 'package.json'), { name: 'inert-export-readiness', version: '1.0.0', type: 'module' });
  await json(join(projectRoot, 'package-lock.json'), { name: 'inert-export-readiness', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'inert-export-readiness', version: '1.0.0' } } });
  await json(join(runtimeRoot, 'package.json'), { name: '@pavangupta352/interleave', version: '0.1.0-test', type: 'module', files: ['dist'], bin: { interleave: 'dist/cli.js' } });
  for (const file of ['source-identity.js', 'cli.js', 'index.js', 'export.js']) await writeFile(join(runtimeRoot, 'dist', file), 'throw new Error("inert fixture must never execute");');
  const scenarioFile = join(projectRoot, 'scenario.mjs');
  await writeFile(scenarioFile, 'throw new Error("inert fixture must never execute");');
  const options = { projectRoot, runtimeRoot, scenarioFile, destination: join(root, 'export') };
  // Synthetic file-format data only, not an executed application qualification.
  const inert: RunResult = {
    schemaVersion: 1, scenario: 'inert-export-readiness', outcome: 'violation', mode: 'explore', plan: [], trace: [],
    actors: [{ actor: 'a', status: 'fulfilled' }, { actor: 'b', status: 'fulfilled' }],
    failure: { name: 'Error', message: 'synthetic fixture', fingerprint: 'a'.repeat(64) },
    environment: { serverVersion: '16.13', nodeVersion: process.version }, startedAt: '2026-09-09T00:00:00.000Z',
    durationMs: 1, limits: { maxSteps: 100, timeoutMs: 10000 }, cleanup: { complete: true },
  };
  return { options, run: await bindExportFixture(inert, options) };
}

function omit(run: RunResult, identity: 'fixture' | 'connections') {
  if (identity === 'fixture') delete run.environment.fixture;
  else delete run.connections;
  expect(parseRunArtifact(run)).toEqual(run);
}

test.each(['fixture', 'connections'] as const)('export rejects a source-bound artifact missing %s before destination creation', async identity => {
  const { options, run } = await fixture();
  omit(run, identity);
  await expect(exportRegression(run, options)).rejects.toThrow(new RegExp(identity === 'fixture' ? 'fixture identity' : 'connection identities'));
  await expect(lstat(options.destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['fixture', 'connections'] as const)('offline verification rejects consistently rehashed legacy evidence missing %s', async identity => {
  const { options, run } = await fixture();
  await exportRegression(run, options);
  omit(run, identity);
  const bytes = Buffer.from(JSON.stringify(run));
  await writeFile(join(options.destination, 'run.json'), bytes);
  const path = join(options.destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const record = manifest.files.find((file: { path: string }) => file.path === 'run.json');
  record.bytes = bytes.length; record.sha256 = hash(bytes);
  const { fingerprint: _old, ...unsigned } = manifest;
  manifest.fingerprint = hash(JSON.stringify(unsigned));
  await json(path, manifest);
  await expect(verifyRegressionExport(options.destination)).rejects.toThrow(new RegExp(identity === 'fixture' ? 'fixture identity' : 'connection identities'));
});
