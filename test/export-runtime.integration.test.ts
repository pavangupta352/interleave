import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { exportRegression } from '../src/export.js';
import type { RunResult } from '../src/types.js';

const temporary: string[] = [];
const inertRun: RunResult = {
  schemaVersion: 1, scenario: 'dependency-install-boundary', outcome: 'violation', mode: 'explore', plan: [], trace: [],
  actors: [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled' }],
  failure: { name: 'AssertionError', message: 'inert npm installation fixture', fingerprint: 'a'.repeat(64) },
  environment: { serverVersion: '16.13', nodeVersion: process.version }, startedAt: '2026-09-09T00:00:00.000Z',
  durationMs: 1, limits: { maxSteps: 100, timeoutMs: 10_000 }, cleanup: { complete: true },
};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
function execute(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
  expect(result.status, result.stderr.slice(-4000)).toBe(0);
  return result.stdout;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test.each([false, true])('clean install preserves app pg 8.11.5 and bundled runtime pg 8.23.0; existing app package=%s', async existingRuntimeName => {
  const root = await mkdtemp(join(tmpdir(), 'interleave runtime isolation ')); temporary.push(root);
  const projectRoot = join(root, 'app-source'); await mkdir(projectRoot);
  // The alias gives the application its own independently locked package under
  // Interleave's name without requiring any unpublished Interleave version.
  const dependencies: Record<string, string> = { pg: '8.11.5', ...(existingRuntimeName ? { '@pavangupta352/interleave': 'npm:is-number@7.0.0' } : {}) };
  const metadata = { name: 'runtime-isolation-app', version: '1.0.0', type: 'module', dependencies };
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify(metadata));
  execute('npm', ['install', '--package-lock-only', '--ignore-scripts'], projectRoot);
  const lock = await json(join(projectRoot, 'package-lock.json'));
  metadata.dependencies.pg = '^8.0.0'; lock.packages[''].dependencies.pg = '^8.0.0';
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify(metadata));
  await writeFile(join(projectRoot, 'package-lock.json'), JSON.stringify(lock));
  const scenarioFile = join(projectRoot, 'scenario.mjs');
  await writeFile(scenarioFile, "import * as runtime from '@pavangupta352/interleave';export default runtime;export const runtimeUrl=import.meta.resolve('@pavangupta352/interleave');");
  const exported = await exportRegression(inertRun, { projectRoot, scenarioFile, destination: join(root, 'ready') });
  const appLockBefore = await readFile(join(exported.destination, 'app/package-lock.json'), 'utf8');
  const runtimeLockBefore = await readFile(join(exported.destination, 'package-lock.json'), 'utf8');
  for (const [command, ...args] of exported.replay.install) execute(command, [...args, '--ignore-scripts'], exported.destination);
  const observed = JSON.parse(execute(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    import { resolve } from 'node:path';
    const app = createRequire(pathToFileURL(resolve('app/scenario.mjs')));
    const runtime = createRequire(pathToFileURL(resolve('node_modules/@pavangupta352/interleave/dist/cli.js')));
    const applicationModule = await import(pathToFileURL(resolve('app/scenario.mjs')));
    console.log(JSON.stringify({ appPg: app('pg/package.json').version, runtimePg: runtime('pg/package.json').version,
      appRuntime: fileURLToPath(applicationModule.runtimeUrl),
      appHasOwnApi: ${existingRuntimeName ? "typeof applicationModule.default.default === 'function'" : "typeof applicationModule.default.exportRegression === 'function'"} }));
  `], exported.destination));
  expect(observed.appPg).toBe('8.11.5');
  expect(observed.runtimePg).toBe('8.23.0');
  expect(observed.appHasOwnApi).toBe(true);
  expect(observed.appRuntime).toBe(join(exported.destination, existingRuntimeName ? 'app/node_modules/@pavangupta352/interleave/index.js' : 'node_modules/@pavangupta352/interleave/dist/index.js'));
  expect(await readFile(join(exported.destination, 'app/package-lock.json'), 'utf8')).toBe(appLockBefore);
  expect(await readFile(join(exported.destination, 'package-lock.json'), 'utf8')).toBe(runtimeLockBefore);
  expect(await readFile(join(exported.destination, 'node_modules/@pavangupta352/interleave/dist/export-source.js'), 'utf8')).not.toMatch(/from\s*["']typescript["']/);
  expect(await readFile(join(exported.destination, 'node_modules/@pavangupta352/interleave/dist/vendor/typescript/LICENSE.txt'), 'utf8')).toContain('Apache License');
  expect((await readFile(join(exported.destination, 'node_modules/@pavangupta352/interleave/dist/vendor/typescript/ThirdPartyNoticeText.txt'), 'utf8')).length).toBeGreaterThan(0);
  // Exercise the parser from the installed production package itself, with no
  // TypeScript development dependency available in this clean directory.
  const repacked = JSON.parse(execute(process.execPath, ['--input-type=module', '-e', `
    import { readFile } from 'node:fs/promises';
    import { resolve } from 'node:path';
    import { exportRegression } from '@pavangupta352/interleave';
    const result = await exportRegression(JSON.parse(await readFile('run.json','utf8')), {
      scenarioFile: resolve('app/scenario.mjs'), projectRoot: resolve('app'), destination: resolve('../re-exported'),
    });
    console.log(JSON.stringify({files:result.files.length}));
  `], exported.destination));
  expect(repacked.files).toBeGreaterThan(0);
}, 120_000);
