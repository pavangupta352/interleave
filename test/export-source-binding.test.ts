import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { exportRegression, verifyRegressionExport } from '../src/export.js';
import { captureSourceIdentity } from '../src/source-identity.js';
import type { RunResult } from '../src/types.js';
import { bindExportFixture } from './helpers/export.js';

const roots: string[] = [];
const inert: RunResult = {
  schemaVersion: 1, scenario: 'inert-export-binding', outcome: 'violation', mode: 'explore', plan: [], trace: [],
  actors: [{ actor: 'a', status: 'fulfilled' }, { actor: 'b', status: 'fulfilled' }], failure: { name: 'Error', message: 'inert source-format fixture', fingerprint: 'a'.repeat(64) },
  environment: { serverVersion: '16.13', nodeVersion: process.version }, startedAt: '2026-09-09T00:00:00.000Z',
  durationMs: 1, limits: { maxSteps: 100, timeoutMs: 10000 }, cleanup: { complete: true },
};
const json = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'interleave-export-binding-')); roots.push(root);
  const projectRoot = join(root, 'app'), runtimeRoot = join(root, 'runtime');
  await mkdir(projectRoot); await mkdir(join(runtimeRoot, 'dist'), { recursive: true });
  await json(join(projectRoot, 'package.json'), { name: 'inert-export-binding', version: '1.0.0', type: 'module' });
  await json(join(projectRoot, 'package-lock.json'), { name: 'inert-export-binding', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'inert-export-binding', version: '1.0.0' } } });
  await json(join(runtimeRoot, 'package.json'), { name: '@pavangupta352/interleave', version: '0.1.0-test', type: 'module', files: ['dist'], bin: { interleave: 'dist/cli.js' } });
  for (const file of ['source-identity.js', 'cli.js', 'export.js', 'index.js']) await writeFile(join(runtimeRoot, 'dist', file), 'throw new Error("must not execute");');
  const scenarioFile = join(projectRoot, 'scenario.mjs');
  await writeFile(scenarioFile, "import './helper.mjs';export default 42;");
  await writeFile(join(projectRoot, 'helper.mjs'), 'export default 42;');
  return { root, projectRoot, runtimeRoot, scenarioFile, destination: join(root, 'export') };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('rejects an unbound legacy recording before creating an export', async () => {
  const f = await fixture();
  await expect(exportRegression(inert, f).then(() => 'exported')).rejects.toThrow(/recorded.*source|file identity|source-bound/i);
});
test('source-mode recordings require a new recording through the built CLI', async () => {
  const f = await fixture(); const source = await captureSourceIdentity(f.scenarioFile, { projectRoot: f.projectRoot });
  await expect(exportRegression({ ...inert, environment: { ...inert.environment, source } }, f).then(() => 'exported')).rejects.toThrow(/built.*CLI|build.*record/i);
});
test.each(['helper.mjs', 'package-lock.json', 'runtime'])('rejects %s changes since recording', async target => {
  const f = await fixture(); const run = await bindExportFixture(inert, f);
  const path = target === 'runtime' ? join(f.runtimeRoot, 'dist/export.js') : join(f.projectRoot, target);
  await writeFile(path, `${await readFile(path, 'utf8')}\n`);
  await expect(exportRegression(run, f).then(() => 'exported')).rejects.toThrow(/identity|recorded.*source|changed|drift/i);
});
test('rejects a runtime archive whose npm file selection omits recorded implementation code', async () => {
  const f = await fixture(); await writeFile(join(f.runtimeRoot, 'dist/omitted.js'), 'export const behavior=42;');
  await json(join(f.runtimeRoot, 'package.json'), { name: '@pavangupta352/interleave', version: '0.1.0-test', type: 'module', files: ['dist/source-identity.js', 'dist/cli.js', 'dist/export.js', 'dist/index.js'] });
  const run = await bindExportFixture(inert, f);
  await expect(exportRegression(run, f).then(() => 'exported')).rejects.toThrow(/packed runtime|archive|omitted.js/i);
});
test('verifies npm extended archive headers for long Unicode runtime filenames', async () => {
  const f = await fixture(); await writeFile(join(f.runtimeRoot, 'dist', `${'é'.repeat(70)}.js`), 'export default 42;');
  const run = await bindExportFixture(inert, f);
  const exported = await exportRegression(run, f);
  await expect(verifyRegressionExport(exported.destination)).resolves.toMatchObject({ runtime: { fingerprint: run.environment.source!.components.runtime.fingerprint } });
});
test('inherits recorded includes and binds offline verification to the historical source bytes', async () => {
  const f = await fixture(); await writeFile(join(f.projectRoot, 'seed.json'), '{"counter":0}');
  const run = await bindExportFixture(inert, { ...f, include: ['seed.json'] });
  const result = await exportRegression(run, f);
  expect(await readFile(join(f.destination, 'app/seed.json'), 'utf8')).toBe('{"counter":0}');
  expect(result.scenario.sourceFingerprint).toBe(run.environment.source!.components.source.fingerprint);
  expect(result.replay.command.slice(-2)).toEqual(['--project-root', 'app']);
  const path = join(f.destination, 'app/helper.mjs'); await writeFile(path, 'export default 999;');
  const manifest = JSON.parse(await readFile(join(f.destination, 'manifest.json'), 'utf8'));
  const bytes = await readFile(path); const record = manifest.files.find((file: { path: string }) => file.path === 'app/helper.mjs');
  record.bytes = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
  const { fingerprint: _old, ...unsigned } = manifest;
  manifest.fingerprint = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  await json(join(f.destination, 'manifest.json'), manifest);
  await expect(verifyRegressionExport(f.destination)).rejects.toThrow(/recorded.*source|source.*record|source.*identity/i);
});

test('rejects modified installed dependency bytes even when its lock and version are unchanged', async () => {
  const f = await fixture(); const driver = join(f.projectRoot, 'node_modules/driver'); await mkdir(driver, { recursive: true });
  await json(join(driver, 'package.json'), { name: 'driver', version: '1.0.0' });
  await writeFile(join(driver, 'index.js'), 'module.exports=42;'); await writeFile(f.scenarioFile, "import 'driver';");
  const run = await bindExportFixture(inert, f);
  await writeFile(join(driver, 'index.js'), 'module.exports=999;');
  await expect(exportRegression(run, f)).rejects.toThrow(/installed dependencies|recorded source identity/i);
});

test('rejects shared application/runtime module instances that separate installation would split', async () => {
  const f = await fixture(); const driver = join(f.root, 'node_modules/driver'); await mkdir(driver, { recursive: true });
  await json(join(driver, 'package.json'), { name: 'driver', version: '1.0.0' });
  await writeFile(join(driver, 'index.js'), 'module.exports=42;'); await writeFile(f.scenarioFile, "import 'driver';");
  const metadata = JSON.parse(await readFile(join(f.runtimeRoot, 'package.json'), 'utf8')); metadata.dependencies = { driver: '1.0.0' };
  await json(join(f.runtimeRoot, 'package.json'), metadata);
  const run = await bindExportFixture(inert, f); expect(run.environment.source!.sharedPackages).toHaveLength(1);
  await expect(exportRegression(run, f)).rejects.toThrow(/shared.*instances|separate.*install/i);
});

test('recaptures source after packaging and rejects changes occurring after application files were copied', async () => {
  const f = await fixture(); const run = await bindExportFixture(inert, f); const originalWrite = fs.writeFile;
  let changed = false;
  fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).endsWith('/export/package.json') && !changed) {
      changed = true; await originalWrite(join(f.projectRoot, 'helper.mjs'), 'export default 999;');
    }
    return originalWrite(...args);
  }) as typeof fs.writeFile;
  syncBuiltinESMExports();
  try { await expect(exportRegression(run, f)).rejects.toThrow(/changed.*recorded source identity/i); }
  finally { fs.writeFile = originalWrite; syncBuiltinESMExports(); }
  expect(changed).toBe(true);
});

test.each(['bytes', 'symlink', 'oversized payload', 'truncated'])('offline verification rejects %s in the packed runtime even with a recomputed outer manifest', async corruption => {
  const f = await fixture(); await exportRegression(await bindExportFixture(inert, f), f);
  const manifest = JSON.parse(await readFile(join(f.destination, 'manifest.json'), 'utf8'));
  const path = join(f.destination, manifest.runtime.package);
  let archive = gunzipSync(await readFile(path));
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const name = archive.subarray(offset, offset + 100).toString().split('\0')[0];
    const size = Number.parseInt(archive.subarray(offset + 124, offset + 136).toString().replace(/\0/g, '').trim(), 8) || 0;
    if (name === 'package/dist/export.js') {
      if (corruption === 'bytes') archive[offset + 512] = 84;
      if (corruption === 'symlink') archive[offset + 156] = 50;
      if (corruption === 'oversized payload') archive.write((16 * 1024 * 1024 + 1).toString(8).padStart(11, '0') + '\0', offset + 124);
      archive.fill(32, offset + 148, offset + 156);
      const checksum = [...archive.subarray(offset, offset + 512)].reduce((sum, value) => sum + value, 0);
      archive.write(checksum.toString(8).padStart(6, '0') + '\0 ', offset + 148);
      break;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(offset).toBeLessThan(archive.length);
  if (corruption === 'truncated') archive = archive.subarray(0, offset + 513);
  const bytes = gzipSync(archive); await writeFile(path, bytes);
  const record = manifest.files.find((file: { path: string }) => file.path === manifest.runtime.package);
  record.bytes = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
  const { fingerprint: _old, ...unsigned } = manifest;
  manifest.fingerprint = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'); await json(join(f.destination, 'manifest.json'), manifest);
  await expect(verifyRegressionExport(f.destination)).rejects.toThrow(/packed runtime|runtime archive/i);
});

test.each([
  ['bundleDependencies', true], ['bundleDependencies', ['driver']],
  ['bundledDependencies', true], ['bundledDependencies', ['driver']],
])('rejects runtime %s=%j before packaging an unqualified bundled dependency graph', async (field, value) => {
  const f = await fixture(); const driver = join(f.runtimeRoot, 'node_modules/driver'); await mkdir(driver, { recursive: true });
  await json(join(driver, 'package.json'), { name: 'driver', version: '1.0.0', main: 'index.js' });
  await writeFile(join(driver, 'index.js'), 'module.exports=42;');
  const metadata = JSON.parse(await readFile(join(f.runtimeRoot, 'package.json'), 'utf8'));
  metadata.dependencies = { driver: '1.0.0' }; metadata[field as string] = value;
  await json(join(f.runtimeRoot, 'package.json'), metadata);
  await expect(exportRegression(await bindExportFixture(inert, f), f).then(() => 'exported')).rejects.toThrow(/bundled.*dependenc|dependenc.*bundl/i);
});

test('empty or disabled runtime bundling declarations preserve ordinary export behavior', async () => {
  const f = await fixture(); const metadata = JSON.parse(await readFile(join(f.runtimeRoot, 'package.json'), 'utf8'));
  metadata.bundleDependencies = false; metadata.bundledDependencies = [];
  await json(join(f.runtimeRoot, 'package.json'), metadata);
  const result = await exportRegression(await bindExportFixture(inert, f), f);
  await expect(verifyRegressionExport(result.destination)).resolves.toMatchObject({ kind: 'interleave-regression' });
});

test.each(['node_modules/driver/index.js', 'dist/node_modules/driver/index.js'])('offline verification rejects an injected %s despite updated archive and lock integrity hashes', async injected => {
  const f = await fixture(); await exportRegression(await bindExportFixture(inert, f), f);
  const manifest = JSON.parse(await readFile(join(f.destination, 'manifest.json'), 'utf8'));
  const path = join(f.destination, manifest.runtime.package);
  const archive = gunzipSync(await readFile(path));
  let end = 0;
  while (end + 512 <= archive.length && archive.subarray(end, end + 512).some(byte => byte !== 0)) {
    const size = Number.parseInt(archive.subarray(end + 124, end + 136).toString().replace(/\0/g, '').trim(), 8) || 0;
    end += 512 + Math.ceil(size / 512) * 512;
  }
  const payload = Buffer.from('module.exports=999;');
  const header = Buffer.from(archive.subarray(0, 512));
  header.fill(0, 0, 100); header.write(`package/${injected}`);
  header.write(payload.length.toString(8).padStart(11, '0') + '\0', 124); header[156] = 48;
  header.fill(0, 157, 257); header.fill(0, 345, 500); header.fill(32, 148, 156);
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const bytes = gzipSync(Buffer.concat([archive.subarray(0, end), header, payload, Buffer.alloc(512 - payload.length), Buffer.alloc(1024)]));
  await writeFile(path, bytes);
  const lockPath = join(f.destination, 'package-lock.json'); const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.packages['node_modules/@pavangupta352/interleave'].integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  await json(lockPath, lock);
  for (const changed of [manifest.runtime.package, 'package-lock.json']) {
    const data = await readFile(join(f.destination, changed)); const record = manifest.files.find((file: { path: string }) => file.path === changed);
    record.bytes = data.length; record.sha256 = createHash('sha256').update(data).digest('hex');
  }
  const { fingerprint: _old, ...unsigned } = manifest;
  manifest.fingerprint = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'); await json(join(f.destination, 'manifest.json'), manifest);
  await expect(verifyRegressionExport(f.destination).then(() => 'verified')).rejects.toThrow(/node_modules|bundled.*dependenc/i);
});
