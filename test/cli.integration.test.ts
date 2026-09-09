import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterEach, describe, expect, test } from 'vitest';
import { testDatabaseUrl } from './helpers/postgres.js';
import { readRunArtifact } from '../src/artifact.js';
const databaseUrl = testDatabaseUrl();
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/cli/${name}.mjs`, import.meta.url));
const temporary: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'interleave CLI ')); temporary.push(path); return path; }
function start(args: string[], extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args, '--json'], {
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}
async function execute(args: string[]) { return start(args).result; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('CLI real PostgreSQL integration', () => {
  test('runs, records, exactly replays and minimizes a real violation, including output paths with spaces', async () => {
    const out = join(await directory(), 'failed run.json');
    const scenario = fixture('path with spaces/scenario');
    const run = await execute(['run', scenario, '--out', out]);
    expect(run.code).toBe(1); expect(run.stderr).toBe('');
    const search = JSON.parse(run.stdout); expect(search.firstFailure.outcome).toBe('violation');
    expect(run.stdout).not.toContain('CLI_SCENARIO_LOG_NOT_JSON');
    const original = await readRunArtifact(out); expect(original.trace).toHaveLength(4);
    expect((await execute(['replay', scenario, out])).code).toBe(1);
    const minimized = await execute(['minimize', scenario, out]);
    expect(minimized.code).toBe(1); expect(JSON.parse(minimized.stdout).locallyMinimal).toBe(true);
    expect((await execute(['minimize', scenario, out, '--max-attempts', '1'])).code).toBe(4);
    expect((await execute(['minimize', scenario, out, '--total-timeout-ms', '1'])).code).toBe(4);
    const before = await readFile(out, 'utf8');
    expect((await execute(['run', scenario, '--out', out])).code).toBe(2);
    expect(await readFile(out, 'utf8')).toBe(before);
    expect((await execute(['run', scenario, '--out', out, '--force'])).code).toBe(1);
  });
  test('uses distinct successful, actor-error, inconclusive and search-budget statuses', async () => {
    expect((await execute(['run', fixture('passed')])).code).toBe(0);
    expect((await execute(['run', fixture('actor-error')])).code).toBe(2);
    expect((await execute(['run', fixture('hung'), '--timeout-ms', '600'])).code).toBe(4);
    const limited = await execute(['run', fixture('counter'), '--max-runs', '1', '--plan', 'alice,alice,bob,bob']);
    expect(limited.code).toBe(4); expect(JSON.parse(limited.stdout).stopReason).toBe('max-runs');
  });
  test('rejects exact replay after fixture change and labels an explicit guided rerun', async () => {
    const artifact = join(await directory(), 'original.json');
    expect((await execute(['run', fixture('counter'), '--out', artifact])).code).toBe(1);
    const exact = await execute(['replay', fixture('changed-counter'), artifact]);
    expect(exact.code).toBe(3); expect(JSON.parse(exact.stdout).outcome).toBe('incompatible');
    const guided = await execute(['replay', fixture('counter'), artifact, '--guided']);
    expect(guided.code).toBe(1); expect(JSON.parse(guided.stdout).mode).toBe('guided');
  });
  test('doctor checks real disposable database and proxy operations', async () => {
    const result = await execute(['doctor']); expect(result.code).toBe(0);
    const run = JSON.parse(result.stdout); expect(run.trace).toHaveLength(2); expect(run.cleanup.complete).toBe(true);
    expect(run.environment.serverVersion).toMatch(/^\d+\./);
  });
  test('demo runs both pinned neveroversell application scenarios through supervision', async () => {
    const unsafe = await execute(['demo', 'neveroversell']); expect(unsafe.code).toBe(1);
    expect(JSON.parse(unsafe.stdout).scenario).toBe('neveroversell-naive-buy-gap-0');
    expect(JSON.parse(unsafe.stdout).trace).toHaveLength(10);
    const safe = await execute(['demo', '--safe']); expect(safe.code).toBe(0);
    expect(JSON.parse(safe.stdout).scenario).toBe('neveroversell-safe-reservations');
    expect(JSON.parse(safe.stdout).actors.map((actor: { value: string }) => actor.value).sort()).toEqual(['held', 'insufficient']);
  });
  test('SIGINT returns 130 after removing the exact owned database', async () => {
    const marker = join(await directory(), 'owned-db');
    const running = start(['run', fixture('hung')], { INTERLEAVE_CLI_TEST_MARKER: marker });
    let name = '';
    try {
      const deadline = Date.now() + 5_000;
      while (!name && Date.now() < deadline) { name = await readFile(marker, 'utf8').catch(() => ''); if (!name) await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(name).toMatch(/^interleave_[a-f0-9]+$/);
      running.child.kill('SIGINT');
      const result = await running.result; expect(result.code).toBe(130); expect(JSON.parse(result.stdout).stopReason).toBe('aborted');
      const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
      try { expect((await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]); }
      finally { await admin.end(); }
    } finally { running.child.kill('SIGTERM'); await running.result; }
  });
});
