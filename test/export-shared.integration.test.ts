import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { verifyRegressionExport } from '../src/export.js';
import { initializeProject } from '../src/cli/init.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const temporary: string[] = [];
const databaseUrl = testDatabaseUrl();
function execute(command: string, args: string[], cwd: string, expected = 0, extra: Record<string, string> = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', ...extra } });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout.slice(-3000)).toBe(expected);
  return result.stdout;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test.each(['8.23.0', '8.11.5'])('init workload exports and clean-replays with original npm graph, app pg %s', async appPg => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave shared install ')); temporary.push(root);
  const archives = join(root, 'original archives'); await mkdir(archives);
  const pack = JSON.parse(execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', archives], repository))[0];
  const archive = join(archives, pack.filename);
  const app = join(root, 'original app');
  await initializeProject(app, pack.version);
  // The default scaffold targets pg ^8.23. The older CommonJS driver needs its
  // ordinary default-import syntax; establish that fixture before recording.
  if (appPg === '8.11.5') await writeFile(join(app, 'scenario.mjs'), (await readFile(join(app, 'scenario.mjs'), 'utf8')).replace("import { Client } from 'pg';", "import pg from 'pg';\nconst { Client } = pg;"));
  const originalScenario = await readFile(join(app, 'scenario.mjs'));
  // Installing the unpublished local tarball is the documented init workflow.
  // These dependency pins are established before any recording.
  execute('npm', ['install', archive, `pg@${appPg}`, '--ignore-scripts'], app);
  const cli = join(app, 'node_modules/@pavangupta352/interleave/dist/cli.js');
  const artifact = join(root, 'original run.json');
  execute(process.execPath, [cli, 'run', 'scenario.mjs', '--project-root', app, '--plan', 'alice,bob,alice,bob', '--max-runs', '1', '--timeout-ms', '20000', '--out', artifact, '--json'], app, 1);
  const recorded = JSON.parse(await readFile(artifact, 'utf8'));
  expect(recorded.outcome).toBe('violation'); expect(recorded.cleanup.complete).toBe(true);
  expect(recorded.environment.source.sharedPackages.length).toBeGreaterThan(0);
  expect(await readFile(join(app, 'scenario.mjs'))).toEqual(originalScenario);
  const destination = join(root, 'portable shared regression');
  const result = JSON.parse(execute(process.execPath, [cli, 'export', 'scenario.mjs', artifact, '--project-root', app, '--runtime-archive', archive, '--out', destination, '--json'], app));
  const manifest = await verifyRegressionExport(destination);
  expect(manifest.installation?.layout).toBe('shared-app');
  expect(manifest.installation?.packages.length).toBeGreaterThan(14);
  const originals = new Map<string, Buffer>();
  for (const path of ['package.json', 'package-lock.json', 'scenario.mjs']) originals.set(`app/${path}`, await readFile(join(app, path)));
  originals.set('run.json', await readFile(artifact));
  // Preserve both the historical object and the user's original JSON bytes.
  expect(JSON.parse(await readFile(join(destination, 'run.json'), 'utf8'))).toEqual(recorded);
  // Force the actual clean installer to use only bundled archives, with no
  // original local tarball path or warm user cache available.
  await rm(archives, { recursive: true });
  const install = execute(process.execPath, ['install.mjs'], destination, 0, { NODE_ENV: 'production', npm_config_omit: 'dev', npm_config_registry: 'https://unavailable.invalid/', npm_config_ignore_scripts: 'false' });
  expect(install).toContain('complete installed identity match');
  const versions = JSON.parse(execute(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';import { resolve } from 'node:path';
    const app=createRequire(resolve('app/package.json'));const runtime=createRequire(resolve('app/node_modules/@pavangupta352/interleave/package.json'));
    console.log(JSON.stringify({app:app('pg/package.json').version,runtime:runtime('pg/package.json').version,same:app('pg').Client===runtime('pg').Client}));
  `], destination));
  expect(versions).toEqual({ app: appPg, runtime: '8.23.0', same: appPg === '8.23.0' });
  const [command, ...args] = result.replay.command;
  const replayed = JSON.parse(execute(command, [...args, '--json'], destination, 1));
  expect(replayed.outcome).toBe('violation'); expect(replayed.cleanup.complete).toBe(true);
  expect(replayed.environment.source).toEqual(recorded.environment.source);
  expect(replayed.environment.fixture.fingerprint).toBe(recorded.environment.fixture.fingerprint);
  expect(replayed.failure.fingerprint).toBe(recorded.failure.fingerprint);
  expect(replayed.trace.map((step: { fingerprint: string }) => step.fingerprint)).toEqual(recorded.trace.map((step: { fingerprint: string }) => step.fingerprint));
  for (const [path, bytes] of originals) {
    expect(await readFile(join(destination, path))).toEqual(bytes);
  }
}, 120_000);
