import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { readRunArtifact, writeRunArtifact } from '../src/artifact.js';
import { verifyRegressionExport } from '../src/export.js';
import { runScenarioFile } from '../src/supervised.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const databaseUrl = testDatabaseUrl();
const temporary: string[] = [];

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function execute(
  command: string,
  args: string[],
  cwd: string,
  extraEnvironment: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, TEST_DATABASE_URL: databaseUrl, ...extraEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolveProcess({ code, stdout, stderr }));
  });
}

async function makeApplication(root: string): Promise<string> {
  const application = join(root, 'application project');
  await mkdir(application);
  await writeFile(join(application, 'scenario.mjs'), `
import assert from 'node:assert/strict';
import { Client } from 'pg';
const increment = async ({ connectionString }) => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT value FROM counter');
    await client.query('UPDATE counter SET value = $1', [rows[0].value + 1]);
  } finally { await client.end(); }
};
export default {
  name: 'portable-export-counter',
  async setup({ db }) { await db.query('CREATE TABLE counter (value int); INSERT INTO counter VALUES (0)'); },
  actors: { alice: increment, bob: increment },
  async invariant({ db }) { assert.equal((await db.query('SELECT value FROM counter')).rows[0].value, 2, 'both increments survive'); },
};
`.trimStart());
  const packageJson = {
    name: 'portable-export-counter',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: { pg: '8.23.0' },
  };
  await writeFile(join(application, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  const lock = JSON.parse(await readFile(join(repository, 'package-lock.json'), 'utf8')) as {
    name: string;
    version: string;
    packages: Record<string, unknown>;
  };
  lock.name = packageJson.name;
  lock.version = packageJson.version;
  lock.packages[''] = packageJson;
  await writeFile(join(application, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return application;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('portable regression export integration', () => {
  test('exports, clean-installs and exactly replays a real failure from a path with spaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interleave portable export '));
    temporary.push(root);
    const application = await makeApplication(root);
    const scenario = join(application, 'scenario.mjs');
    const installApplication = await execute(npmExecutable(), ['ci', '--ignore-scripts'], application);
    expect(installApplication.code).toBe(0);

    const recorded = await runScenarioFile(scenario, {
      databaseUrl,
      plan: ['alice', 'bob', 'alice', 'bob'],
      timeoutMs: 20_000,
    });
    expect(recorded.outcome).toBe('violation');
    const artifact = join(root, 'recorded failure.json');
    await writeRunArtifact(artifact, recorded);

    const destination = join(root, 'ready regression folder');
    const exported = await execute(process.execPath, [
      '--import', import.meta.resolve('tsx'), cli,
      'export', scenario, artifact,
      '--project-root', application,
      '--out', destination,
      '--json',
    ], repository, { TEST_DATABASE_URL: '', INTERLEAVE_TEST_DATABASE_URL: '' });
    expect(exported.code).toBe(0);
    expect(exported.stderr).toBe('');
    const result = JSON.parse(exported.stdout) as {
      fingerprint: string;
      replay: { install: [string, ...string[]][]; command: [string, ...string[]] };
    };
    const manifest = await verifyRegressionExport(destination);
    expect(result.fingerprint).toBe(manifest.fingerprint);
    expect(await readFile(join(destination, 'app/scenario.mjs'), 'utf8')).toBe(
      await readFile(scenario, 'utf8'),
    );
    const bundledRun = await readRunArtifact(join(destination, 'run.json'));
    expect(bundledRun.trace.map((step) => step.sql)).toEqual(recorded.trace.map((step) => step.sql));

    for (const [command, ...args] of result.replay.install) {
      const installed = await execute(command, [...args, '--ignore-scripts'], destination);
      expect(installed.code, installed.stderr).toBe(0);
    }
    const [replayCommand, ...replayArgs] = result.replay.command;
    const replayed = await execute(replayCommand, [...replayArgs, '--json'], destination);
    expect(replayed.code).toBe(1);
    expect(replayed.stderr).toBe('');
    const replay = JSON.parse(replayed.stdout);
    expect(replay.outcome).toBe('violation');
    expect(replay.failure.fingerprint).toBe(recorded.failure?.fingerprint);
    expect(replay.trace.map((step: { fingerprint: string }) => step.fingerprint)).toEqual(
      recorded.trace.map((step) => step.fingerprint),
    );
  }, 60_000);
});
