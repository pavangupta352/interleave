import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { exportRegression, verifyRegressionExport } from '../src/export.js';
import type { RunResult } from '../src/types.js';

const temporary: string[] = [];
function loadModule(file: string): unknown {
  // Use the real Node loader: Vitest transforms imports and can resolve URLs differently.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import {pathToFileURL} from 'node:url'; console.log(JSON.stringify((await import(pathToFileURL(process.argv[1]).href)).default));", file], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' } });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}
const run: RunResult = {
  schemaVersion: 1, scenario: 'export-resolution-fixture', outcome: 'violation', mode: 'explore', plan: [], trace: [],
  actors: [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled' }],
  failure: { name: 'AssertionError', message: 'inert module-resolution fixture', fingerprint: 'a'.repeat(64) },
  environment: { serverVersion: '16.13', nodeVersion: process.version }, startedAt: '2026-09-09T00:00:00.000Z',
  durationMs: 1, limits: { maxSteps: 100, timeoutMs: 10000 }, cleanup: { complete: true },
};
async function fixture(entry: string, type: 'module' | 'commonjs' = 'module') {
  const root = await mkdtemp(join(tmpdir(), 'interleave-export-resolution-')); temporary.push(root);
  const projectRoot = join(root, 'project'), runtimeRoot = join(root, 'runtime');
  await mkdir(projectRoot); await mkdir(join(runtimeRoot, 'dist'), { recursive: true });
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'resolution-fixture', version: '1.0.0', type }));
  await writeFile(join(projectRoot, 'package-lock.json'), JSON.stringify({ name: 'resolution-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'resolution-fixture', version: '1.0.0' } } }));
  await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({ name: '@pavangupta352/interleave', version: '0.1.0-test', type: 'module', files: ['dist'], bin: { interleave: 'dist/cli.js' } }));
  for (const file of ['cli.js', 'export.js', 'index.js']) await writeFile(join(runtimeRoot, 'dist', file), 'export {};');
  return { projectRoot, runtimeRoot, scenarioFile: join(projectRoot, entry), destination: join(root, 'export') };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test.each(['js', 'json'])('CJS extensionless require retains Node\'s .%s module ahead of a same-name .mjs file', async extension => {
  const f = await fixture('scenario.cjs', 'commonjs');
  await writeFile(f.scenarioFile, "module.exports=require('./helper');");
  await writeFile(join(f.projectRoot, `helper.${extension}`), extension === 'js' ? 'module.exports=42;' : '42');
  await writeFile(join(f.projectRoot, 'helper.mjs'), 'export default 999;');
  expect(loadModule(f.scenarioFile)).toBe(42);
  const exported = await exportRegression(run, f); await verifyRegressionExport(exported.destination);
  const copied = join(f.destination, 'app/scenario.cjs');
  expect(loadModule(copied)).toBe(42);
});

test('ESM imports resolve percent-encoded URLs to the same decoded file after export', async () => {
  const f = await fixture('scenario.mjs');
  await writeFile(f.scenarioFile, "export { default } from './helper%20file.mjs';");
  await writeFile(join(f.projectRoot, 'helper file.mjs'), 'export default 42;');
  await writeFile(join(f.projectRoot, 'helper%20file.mjs'), 'export default 999;');
  expect(loadModule(f.scenarioFile)).toBe(42);
  const exported = await exportRegression(run, f); await verifyRegressionExport(exported.destination);
  expect(loadModule(join(f.destination, 'app/scenario.mjs'))).toBe(42);
});

test('CJS require keeps literal percent characters rather than decoding them as an ESM URL', async () => {
  const f = await fixture('scenario.cjs', 'commonjs');
  await writeFile(f.scenarioFile, "module.exports=require('./helper%20file.js');");
  await writeFile(join(f.projectRoot, 'helper file.js'), 'module.exports=999;');
  await writeFile(join(f.projectRoot, 'helper%20file.js'), 'module.exports=42;');
  const exported = await exportRegression(run, f);
  const copied = join(exported.destination, 'app/scenario.cjs');
  expect(loadModule(copied)).toBe(42);
});

test.each([
  ['extensionless ESM', "import './helper';export default 42;", 'helper.mjs'],
  ['missing JavaScript with TypeScript available', "import './helper.js';export default 42;", 'helper.ts'],
])('standalone export rejects %s instead of inventing Node loader fallbacks', async (_label, source, helper) => {
  const f = await fixture('scenario.mjs');
  await writeFile(f.scenarioFile, source); await writeFile(join(f.projectRoot, helper), 'export default 42;');
  await expect(exportRegression(run, f)).rejects.toThrow(/resolve|exact|unsupported/i);
});

test('CJS directory lookup is explicitly unsupported instead of choosing a different index module', async () => {
  const f = await fixture('scenario.cjs', 'commonjs');
  await writeFile(f.scenarioFile, "module.exports=require('./helper');");
  await mkdir(join(f.projectRoot, 'helper'));
  await writeFile(join(f.projectRoot, 'helper/index.js'), 'module.exports=42;');
  await writeFile(join(f.projectRoot, 'helper/index.mjs'), 'export default 999;');
  expect(loadModule(f.scenarioFile)).toBe(42);
  await expect(exportRegression(run, f)).rejects.toThrow(/directory|unsupported/i);
});

test('nested package metadata preserves the actual module type of a relative .js dependency', async () => {
  const f = await fixture('scenario.mjs');
  await writeFile(f.scenarioFile, "export { default } from './nested/helper.js';");
  await mkdir(join(f.projectRoot, 'nested'));
  await writeFile(join(f.projectRoot, 'nested/package.json'), '{"type":"commonjs"}');
  await writeFile(join(f.projectRoot, 'nested/helper.js'), 'module.exports=42;');
  expect(loadModule(f.scenarioFile)).toBe(42);
  const exported = await exportRegression(run, f); await verifyRegressionExport(exported.destination);
  expect(await readFile(join(f.destination, 'app/nested/package.json'), 'utf8')).toBe('{"type":"commonjs"}');
  expect(loadModule(join(f.destination, 'app/scenario.mjs'))).toBe(42);
});

test('type-only TypeScript imports do not invent a runtime dependency on a missing module', async () => {
  const f = await fixture('scenario.ts');
  await writeFile(f.scenarioFile, "import type { Something } from './missing.js';export default 42;");
  const exported = await exportRegression(run, f);
  expect(loadModule(join(exported.destination, 'app/scenario.ts'))).toBe(42);
});

test('a trailing slash on a CJS specifier cannot silently become an exact filename', async () => {
  const f = await fixture('scenario.cjs', 'commonjs');
  await writeFile(f.scenarioFile, "module.exports=require('./helper/');");
  await writeFile(join(f.projectRoot, 'helper'), 'module.exports=42;');
  await expect(exportRegression(run, f)).rejects.toThrow(/directory|unsupported/i);
});

test('native modules are rejected before a portable export can claim their source graph', async () => {
  const f = await fixture('scenario.cjs', 'commonjs');
  await writeFile(f.scenarioFile, "module.exports=require('./helper.node');");
  await writeFile(join(f.projectRoot, 'helper.node'), 'native fixture placeholder');
  await expect(exportRegression(run, f)).rejects.toThrow(/native.*unsupported/i);
});

test('custom require.resolve lookup paths cannot be mistaken for importer-relative resolution', async () => {
  const f = await fixture('scenario.cjs', 'commonjs');
  await writeFile(f.scenarioFile, "module.exports=require.resolve('./helper', {paths:[__dirname+'/other']});");
  await writeFile(join(f.projectRoot, 'helper.js'), 'module.exports=999;');
  await mkdir(join(f.projectRoot, 'other'));
  await writeFile(join(f.projectRoot, 'other/helper.js'), 'module.exports=42;');
  expect(String(loadModule(f.scenarioFile))).toMatch(/other[/\\]helper\.js$/);
  await expect(exportRegression(run, f)).rejects.toThrow(/custom|unsupported/i);
});
