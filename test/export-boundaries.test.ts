import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { exportRegression, verifyRegressionExport } from '../src/export.js';
import type { RunResult } from '../src/types.js';

const temporary: string[] = [];
const run: RunResult = {
  schemaVersion: 1, scenario: 'export-boundary-fixture', outcome: 'violation', mode: 'explore',
  plan: [], trace: [], actors: [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled' }],
  failure: { name: 'AssertionError', message: 'inert file-format fixture', fingerprint: 'a'.repeat(64) },
  environment: { serverVersion: '16.13', nodeVersion: process.version }, startedAt: '2026-09-09T00:00:00.000Z',
  durationMs: 1, limits: { maxSteps: 100, timeoutMs: 10_000 }, cleanup: { complete: true },
};
const json = async (path: string, value: unknown) => fs.writeFile(path, JSON.stringify(value));
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'interleave export boundary '))); temporary.push(root);
  const projectRoot = join(root, 'project'); const runtimeRoot = join(root, 'runtime');
  await fs.mkdir(projectRoot); await fs.mkdir(join(runtimeRoot, 'dist'), { recursive: true });
  const scenarioFile = join(projectRoot, 'scenario.mjs');
  await fs.writeFile(scenarioFile, 'export default 42;');
  await json(join(projectRoot, 'package.json'), { name: 'export-boundary', version: '1.0.0', type: 'module' });
  await json(join(projectRoot, 'package-lock.json'), { name: 'export-boundary', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'export-boundary', version: '1.0.0' } } });
  await json(join(runtimeRoot, 'package.json'), { name: '@pavangupta352/interleave', version: '0.1.0-test', type: 'module', files: ['dist'], bin: { interleave: 'dist/cli.js' } });
  for (const file of ['cli.js', 'export.js', 'index.js']) await fs.writeFile(join(runtimeRoot, 'dist', file), 'export {};');
  return { root, projectRoot, runtimeRoot, scenarioFile, destination: join(root, 'result') };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))); });

test('retains valid compact and escaped static imports without interpreting comments as imports', async () => {
  const f = await fixture();
  await fs.writeFile(f.scenarioFile, "import{value}from'./he\\u006cper.mjs';/* import './absent.mjs'; */export{other}from'./other.mjs';export default value;");
  await fs.writeFile(join(f.projectRoot, 'helper.mjs'), 'export const value=42;');
  await fs.writeFile(join(f.projectRoot, 'other.mjs'), 'export const other=43;');
  const exported = await exportRegression(run, f);
  await verifyRegressionExport(exported.destination);
  const imported = await import(pathToFileURL(join(f.destination, 'app/scenario.mjs')).href);
  expect(imported.default).toBe(42); expect(imported.other).toBe(43);
});

test('rejects computed module imports explicitly instead of claiming an inferred complete graph', async () => {
  const f = await fixture();
  await fs.writeFile(f.scenarioFile, "const name='./helper.mjs';export default await import(name);");
  await expect(exportRegression(run, f)).rejects.toThrow(/computed|dynamic|literal|unsupported/i);
});

test.each(['declarations', 'package records'])('rejects stale lock %s without executing application lifecycle scripts', async missing => {
  const f = await fixture();
  const marker = join(f.projectRoot, 'lifecycle-ran');
  await json(join(f.projectRoot, 'package.json'), { name: 'export-boundary', version: '1.0.0', dependencies: { pg: '8.23.0' }, scripts: { preinstall: `node -e "require('fs').writeFileSync('${marker}', 'ran')"` } });
  if (missing === 'package records') {
    await json(join(f.projectRoot, 'package-lock.json'), { name: 'export-boundary', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'export-boundary', version: '1.0.0', dependencies: { pg: '8.23.0' } } } });
  }
  await expect(exportRegression(run, f)).rejects.toThrow(/lock|dependency|missing/i);
  expect(await fs.lstat(marker).then(() => true, () => false)).toBe(false);
});

test('refuses a concurrent empty destination instead of replacing its inode', async () => {
  const f = await fixture(); const originalMkdir = fs.mkdir; const originalRename = fs.rename;
  let concurrentInode: number | undefined;
  const claim = async () => { await originalMkdir(f.destination); concurrentInode = (await fs.lstat(f.destination)).ino; };
  fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => { if (args[0] === f.destination && concurrentInode === undefined) await claim(); return originalMkdir(...args); }) as typeof fs.mkdir;
  fs.rename = async (from, to) => { if (to === f.destination && concurrentInode === undefined) await claim(); return originalRename(from, to); };
  syncBuiltinESMExports();
  try { await expect(exportRegression(run, f)).rejects.toThrow(/exists|overwrite/i); }
  finally { fs.mkdir = originalMkdir; fs.rename = originalRename; syncBuiltinESMExports(); }
  expect((await fs.lstat(f.destination)).ino).toBe(concurrentInode);
  expect(await fs.readdir(f.destination)).toEqual([]);
});

test('preserves a replacement directory on failure and names the incomplete output for recovery', async () => {
  const f = await fixture(); const originalWrite = fs.writeFile; let replacement: string | undefined;
  fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).endsWith('/app/package.json') && !replacement) {
      const output = dirname(dirname(String(args[0])));
      await fs.rename(output, `${output}.owned`); await fs.mkdir(output);
      replacement = join(output, 'concurrent-content'); await originalWrite(replacement, 'preserve');
      throw new Error('Injected write failure');
    }
    return originalWrite(...args);
  }) as typeof fs.writeFile;
  syncBuiltinESMExports();
  let failure: unknown;
  try { await exportRegression(run, f); } catch (error) { failure = error; }
  finally { fs.writeFile = originalWrite; syncBuiltinESMExports(); }
  expect(failure).toBeInstanceOf(Error);
  expect(await fs.readFile(replacement!, 'utf8')).toBe('preserve');
  expect(String(failure)).toMatch(/incomplete|partial|recovery|preserv/i);
});

test('human replay commands preserve literal shell metacharacters in entry paths', async () => {
  const f = await fixture(); const scenario = join(f.projectRoot, "scenario'$(printf changed).mjs");
  await fs.rename(f.scenarioFile, scenario); await json(join(f.root, 'run.json'), run);
  const command = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, 'export', scenario, join(f.root, 'run.json'), '--project-root', f.projectRoot, '--out', f.destination], { encoding: 'utf8', timeout: 60_000 });
  expect(command.status, command.stderr).toBe(0);
  const printed = command.stdout.trim().split('\n').at(-1)!;
  // Replace the executable only, then ask a real shell to report its arguments.
  const argumentText = printed.replace(/^(?:"npm"|'npm'|npm|"node"|'node'|node)\s+/, 'printf \'%s\\n\' ');
  const shell = spawnSync('/bin/sh', ['-c', argumentText], { encoding: 'utf8' });
  expect(shell.status).toBe(0);
  expect(shell.stdout.split('\n')).toContain("app/scenario'$(printf changed).mjs");
}, 60_000);
