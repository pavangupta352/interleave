import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { exportRegression, verifyRegressionExport } from '../src/export.js';
import { bindExportFixture } from './helpers/export.js';
import type { RunResult } from '../src/types.js';

const execute = promisify(execFile);
const roots: string[] = [];
const json = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
const inert: RunResult = {
  schemaVersion: 1, scenario: 'shared-format', outcome: 'violation', mode: 'explore', plan: [], trace: [],
  actors: [{ actor: 'a', status: 'fulfilled' }, { actor: 'b', status: 'fulfilled' }],
  failure: { name: 'Error', message: 'inert archive format fixture', fingerprint: 'a'.repeat(64) },
  environment: { serverVersion: '16.13', nodeVersion: process.version }, startedAt: '2026-09-09T00:00:00.000Z',
  durationMs: 1, limits: { maxSteps: 100, timeoutMs: 10000 }, cleanup: { complete: true },
};
async function npm(args: string[], cwd: string) {
  return execute('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '', npm_config_update_notifier: 'false' } });
}
async function fixture(importPath = 'driver', importRuntime = true) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave-shared-export-')); roots.push(root);
  const projectRoot = join(root, 'app'), build = join(root, 'runtime'), driver = join(root, 'driver');
  await mkdir(join(projectRoot, 'archives'), { recursive: true }); await mkdir(join(build, 'dist'), { recursive: true }); await mkdir(driver);
  const driverName = importPath.startsWith('@') ? '@fixture/driver' : 'driver';
  const driverArchive = `${driverName === 'driver' ? '' : 'fixture-'}driver-1.0.0.tgz`;
  await json(join(driver, 'package.json'), { name: driverName, version: '1.0.0', main: 'index.js', exports: { '.': './index.js', './subpath': './index.js' } });
  await writeFile(join(driver, 'index.js'), 'module.exports=42;');
  await npm(['pack', '--pack-destination', join(projectRoot, 'archives')], driver);
  await json(join(build, 'package.json'), { name: '@pavangupta352/interleave', version: '0.1.0-test', type: 'module', main: 'dist/index.js', files: ['dist', 'README.md'], dependencies: { [driverName]: '1.0.0' } });
  for (const file of ['source-identity.js', 'index.js', 'cli.js']) await writeFile(join(build, 'dist', file), 'throw Error("inert format fixture must not execute");');
  await writeFile(join(build, 'README.md'), 'original documentation');
  await npm(['pack', '--pack-destination', join(projectRoot, 'archives')], build);
  const runtimeArchive = join(projectRoot, 'archives/pavangupta352-interleave-0.1.0-test.tgz');
  await json(join(projectRoot, 'package.json'), { name: 'shared-format', version: '1.0.0', type: 'module', dependencies: { '@pavangupta352/interleave': 'file:archives/pavangupta352-interleave-0.1.0-test.tgz', [driverName]: `file:archives/${driverArchive}` } });
  await npm(['install'], projectRoot);
  const runtimeRoot = join(projectRoot, 'node_modules/@pavangupta352/interleave');
  const scenarioFile = join(projectRoot, 'scenario.mjs'); await writeFile(scenarioFile, `${importRuntime ? "import '@pavangupta352/interleave';" : ''}import '${importPath}';`);
  const options = { projectRoot, runtimeRoot, scenarioFile, destination: join(root, 'export'), runtimeArchive };
  const run = await bindExportFixture(inert, options);
  expect(run.environment.source!.sharedPackages).toHaveLength(1);
  return { root, build, run, options };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test.each(['driver/subpath', '@fixture/driver/subpath'])('preserves %s root imports in an unchanged shared installation', async specifier => {
  const { run, options } = await fixture(specifier);
  expect(run.environment.source!.components.dependencies.roots.some(edge => edge.name === specifier)).toBe(true);
  const result = await exportRegression(run, options);
  const manifest = await verifyRegressionExport(result.destination);
  expect(manifest.installation?.layout).toBe('shared-app');
  expect(JSON.parse(await readFile(join(result.destination, 'run.json'), 'utf8')).environment.source).toEqual(run.environment.source);
  expect(await readFile(join(result.destination, 'app/scenario.mjs'))).toEqual(await readFile(options.scenarioFile));
});

test('exports a plain-object scenario without adding an otherwise unused runtime API import', async () => {
  const { run, options } = await fixture('driver', false);
  expect(run.environment.source!.components.dependencies.packages.some(node => node.name === '@pavangupta352/interleave')).toBe(false);
  const result = await exportRegression(run, options);
  await expect(verifyRegressionExport(result.destination)).resolves.toHaveProperty('installation.layout', 'shared-app');
  expect(JSON.parse(await readFile(join(result.destination, 'run.json'), 'utf8')).environment.source).toEqual(run.environment.source);
});

test('still rejects changed runtime implementation bytes without an application runtime API import', async () => {
  const { options } = await fixture('driver', false);
  await writeFile(join(options.runtimeRoot, 'dist/cli.js'), 'throw Error("changed runtime implementation");');
  const run = await bindExportFixture(inert, options);
  await expect(exportRegression(run, options)).rejects.toThrow(/runtime.*(match|byte)|archive.*runtime/i);
});

test('exports an unchanged original shared npm installation with durable offline archives', async () => {
  const { run, options } = await fixture();
  const result = await exportRegression(run, options);
  const manifest = await verifyRegressionExport(result.destination);
  expect(manifest).toMatchObject({ installation: { layout: 'shared-app', profile: 'npm-offline-v1' }, replay: { install: [['node', 'install.mjs']] } });
  for (const path of ['package.json', 'package-lock.json', 'scenario.mjs']) expect(await readFile(join(result.destination, 'app', path))).toEqual(await readFile(join(options.projectRoot, path)));
  const artifact = JSON.parse(await readFile(join(result.destination, 'run.json'), 'utf8'));
  expect(artifact.environment.source).toEqual(run.environment.source);
  expect(result.replay.command[1]).toBe('app/node_modules/@pavangupta352/interleave/dist/cli.js');
});

test('rejects a matching locked archive when historical installed runtime package bytes were modified', async () => {
  const { options } = await fixture();
  await writeFile(join(options.runtimeRoot, 'README.md'), 'locally modified before recording');
  const run = await bindExportFixture(inert, options);
  await expect(exportRegression(run, options)).rejects.toThrow(/archive.*recorded.*package|package.*bytes/i);
});

test('rejects an archive that does not match the original lock integrity without rewriting the lock', async () => {
  const { run, options } = await fixture(); const original = await readFile(join(options.projectRoot, 'package-lock.json'));
  await writeFile(options.runtimeArchive, Buffer.from('different bytes'));
  await expect(exportRegression(run, options)).rejects.toThrow(/integrity|original.*archive/i);
  expect(await readFile(join(options.projectRoot, 'package-lock.json'))).toEqual(original);
});

test('rejects an explicit runtime archive symlink', async () => {
  const { run, options, root } = await fixture(); const path = join(root, 'linked.tgz'); await symlink(options.runtimeArchive, path);
  await expect(exportRegression(run, { ...options, runtimeArchive: path })).rejects.toThrow(/symbolic link/i);
});

test('offline verification rejects an altered original lock mapping even when outer hashes are recomputed', async () => {
  const { run, options } = await fixture(); const result = await exportRegression(run, options);
  const path = join(result.destination, 'manifest.json'); const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.installation.packages[0].lockPath = 'node_modules/another';
  const { fingerprint: _old, ...unsigned } = manifest; manifest.fingerprint = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  await json(path, manifest);
  await expect(verifyRegressionExport(result.destination)).rejects.toThrow(/lock|archive|installation/i);
});

test('discovers contained original archives without an explicit archive option', async () => {
  const { run, options } = await fixture(); const { runtimeArchive: _explicit, ...discovered } = options;
  await expect(exportRegression(run, discovered)).resolves.toHaveProperty('manifestPath');
});

test('missing original runtime archive produces an actionable explicit archive diagnostic', async () => {
  const { run, options } = await fixture(); const { runtimeArchive, ...discovered } = options; await rm(runtimeArchive);
  await expect(exportRegression(run, discovered)).rejects.toThrow(/runtimeArchive|original.*archive/i);
});

test('does not ignore unused explicit dependency archives', async () => {
  const { run, options, root } = await fixture(); const extra = join(root, 'unmatched.tgz'); await writeFile(extra, 'not a locked archive');
  await expect(exportRegression(run, { ...options, dependencyArchives: [extra] })).rejects.toThrow(/unmatched|unused|not.*lock/i);
});

test('a private locked archive requires explicit bytes and never implicitly fetches the private URL', async () => {
  const { options } = await fixture(); const path = join(options.projectRoot, 'package-lock.json'); const lock = JSON.parse(await readFile(path, 'utf8'));
  const metadata = JSON.parse(await readFile(join(options.projectRoot, 'package.json'), 'utf8')); metadata.dependencies.driver = '1.0.0';
  lock.packages[''].dependencies.driver = '1.0.0';
  lock.packages['node_modules/driver'].resolved = 'https://private.example.invalid/secret-token/driver.tgz'; await json(path, lock); await json(join(options.projectRoot, 'package.json'), metadata);
  const run = await bindExportFixture(inert, options);
  await expect(exportRegression(run, options)).rejects.toThrow(/explicit archive/i);
  await expect(exportRegression(run, { ...options, dependencyArchives: [join(options.projectRoot, 'archives/driver-1.0.0.tgz')] })).resolves.toHaveProperty('manifestPath');
});

test('runtimeArchive must itself match the runtime even if another supplied archive has the correct bytes', async () => {
  const { run, options } = await fixture();
  await expect(exportRegression(run, { ...options, runtimeArchive: join(options.projectRoot, 'archives/driver-1.0.0.tgz'), dependencyArchives: [options.runtimeArchive] })).rejects.toThrow(/runtimeArchive.*integrity|integrity.*runtimeArchive/i);
});

test('preserves explicitly supplied original artifact bytes and rejects a different artifact', async () => {
  const { run, options, root } = await fixture(); const artifactFile = join(root, 'original.json'); const original = Buffer.from(JSON.stringify(run) + '\n\n'); await writeFile(artifactFile, original);
  const result = await exportRegression(run, { ...options, artifactFile });
  expect(await readFile(join(result.destination, 'run.json'))).toEqual(original);
  await json(artifactFile, { ...run, scenario: 'different' });
  await expect(exportRegression(run, { ...options, destination: join(root, 'different'), artifactFile })).rejects.toThrow(/artifact.*match|artifact.*differ/i);
});

test('preserves npm lock format 2 without rewriting it', async () => {
  const { options } = await fixture(); await npm(['install', '--package-lock-only', '--lockfile-version=2'], options.projectRoot);
  const run = await bindExportFixture(inert, options); const original = await readFile(join(options.projectRoot, 'package-lock.json'));
  expect(JSON.parse(original.toString()).lockfileVersion).toBe(2);
  const result = await exportRegression(run, options);
  expect(await readFile(join(result.destination, 'app/package-lock.json'))).toEqual(original);
});

test('one identical archive can bind two distinct locked package instances without dropping their graph edges', async () => {
  const { options } = await fixture(); const path = join(options.projectRoot, 'package-lock.json'); const lock = JSON.parse(await readFile(path, 'utf8'));
  const nested = 'node_modules/@pavangupta352/interleave/node_modules/driver';
  await cp(join(options.projectRoot, 'node_modules/driver'), join(options.projectRoot, nested), { recursive: true });
  lock.packages[nested] = structuredClone(lock.packages['node_modules/driver']); await json(path, lock);
  const run = await bindExportFixture(inert, options);
  expect(run.environment.source!.components.dependencies.packages.filter(node => node.name === 'driver')).toHaveLength(2);
  const result = await exportRegression(run, options); const manifest = await verifyRegressionExport(result.destination);
  const bindings = manifest.installation!.packages.filter(item => item.lockPath.endsWith('/driver'));
  expect(bindings).toHaveLength(2); expect(new Set(bindings.map(item => item.archive)).size).toBe(1);
  expect(JSON.parse(await readFile(join(result.destination, 'run.json'), 'utf8')).environment.source).toEqual(run.environment.source);
});

test('rejects a historically missing optional dependency present in the install lock', async () => {
  const { options } = await fixture(); const path = join(options.projectRoot, 'package-lock.json'); const lock = JSON.parse(await readFile(path, 'utf8'));
  const metadataPath = join(options.projectRoot, 'node_modules/driver/package.json'); const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.optionalDependencies = { ghost: '1.0.0' }; await json(metadataPath, metadata);
  lock.packages['node_modules/ghost'] = structuredClone(lock.packages['node_modules/driver']); await json(path, lock);
  const run = await bindExportFixture(inert, options);
  await expect(exportRegression(run, options)).rejects.toThrow(/historically missing optional/);
});

test('rejects dependency install hooks declared in the original lock', async () => {
  const { options } = await fixture(); const path = join(options.projectRoot, 'package-lock.json'); const lock = JSON.parse(await readFile(path, 'utf8'));
  lock.packages['node_modules/driver'].hasInstallScript = true; await json(path, lock);
  await expect(exportRegression(await bindExportFixture(inert, options), options)).rejects.toThrow(/install-script/i);
});

test('rejects a lock that would split a historically shared package instance', async () => {
  const { options } = await fixture(); const path = join(options.projectRoot, 'package-lock.json'); const lock = JSON.parse(await readFile(path, 'utf8'));
  lock.packages['node_modules/@pavangupta352/interleave/node_modules/driver'] = structuredClone(lock.packages['node_modules/driver']); await json(path, lock);
  const run = await bindExportFixture(inert, options);
  await expect(exportRegression(run, options)).rejects.toThrow(/splits|shared.*topology|graph/i);
});

test.each(['.npmrc', 'npm-shrinkwrap.json'])('rejects %s overriding the qualified original lock installer', async path => {
  const { options } = await fixture(); await writeFile(join(options.projectRoot, path), path === '.npmrc' ? 'omit=dev' : '{}');
  const run = await bindExportFixture(inert, options);
  await expect(exportRegression(run, options)).rejects.toThrow(/npmrc|shrinkwrap/i);
});

test('offline verification rejects an installer options edit with recomputed outer file hashes', async () => {
  const { run, options } = await fixture(); const result = await exportRegression(run, options);
  const file = join(result.destination, 'install.mjs'); const before = await readFile(file, 'utf8'); expect(before).toContain('--ignore-scripts=true');
  const bytes = Buffer.from(before.replace('--ignore-scripts=true', '--ignore-scripts=false')); await writeFile(file, bytes);
  const path = join(result.destination, 'manifest.json'); const manifest = JSON.parse(await readFile(path, 'utf8'));
  const record = manifest.files.find((file: { path: string }) => file.path === 'install.mjs'); record.bytes = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
  const { fingerprint: _old, ...unsigned } = manifest; manifest.fingerprint = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'); await json(path, manifest);
  await expect(verifyRegressionExport(result.destination)).rejects.toThrow(/installer.*contract/i);
});
