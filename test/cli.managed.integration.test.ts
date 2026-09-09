import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';

const exec = promisify(execFile);
const cli = process.env.INTERLEAVE_TEST_INSTALLED_CLI ?? fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/cli/${name}.mjs`, import.meta.url));
const directories: string[] = [];
const evidence = process.env.INTERLEAVE_MANAGED_EVIDENCE_DIR;
let commandIndex = 0;
async function directory() { const path = await mkdtemp(join(tmpdir(), 'interleave managed CLI ')); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function start(args: string[], extra: Record<string, string> = {}, closeProgress = false) {
  const index = ++commandIndex, startedAt = new Date().toISOString();
  const env = { ...process.env, ...extra }; delete env.TEST_DATABASE_URL; delete env.INTERLEAVE_TEST_DATABASE_URL;
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', observedName: string | undefined;
  let observation: Promise<string> | undefined;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (closeProgress && stderr.includes('Starting disposable')) child.stderr.destroy();
    const match = /Disposable PostgreSQL is ready \((interleave-cli-[a-f0-9-]{36})\)/.exec(stderr);
    if (match && !observation) {
      observedName = match[1]!;
      observation = exec('docker', ['inspect', '--type', 'container', '--format', '{{.Id}} {{.Image}}', observedName], { timeout: 10_000, maxBuffer: 1024 * 1024 }).then(result => result.stdout.trim());
      // The result is consumed below even if inspection fails before close.
      void observation.catch(() => {});
    }
  });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string; identity?: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      try {
        const identity = observation ? await observation : undefined;
        const names = [...new Set(stderr.match(/interleave-cli-[a-f0-9-]{36}/g) ?? [])];
        const absence = [];
        for (const name of names) {
          let failure: unknown;
          try { await exec('docker', ['inspect', '--type', 'container', name], { timeout: 10_000 }); }
          catch (error) { failure = error; }
          expect(failure, `managed container still exists: ${name}`).toBeDefined();
          const text = String((failure as { stderr?: string }).stderr ?? '');
          expect(text).toMatch(new RegExp('No such (object|container): ' + name));
          absence.push({ name, stderr: text.trim() });
        }
        const metadata = { index, args, pid: child.pid, code, signal, startedAt, finishedAt: new Date().toISOString(), observedName, identity, absence };
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          const base = join(evidence, String(index).padStart(2, '0'));
          await writeFile(base + '.json', JSON.stringify(metadata, null, 2) + '\n');
          await writeFile(base + '.stdout', stdout); await writeFile(base + '.stderr', stderr);
        }
        console.log(JSON.stringify({ managedCommand: metadata }));
        expect(signal).toBeNull();
        if (observedName) expect(identity).toMatch(/^[a-f0-9]{64} sha256:[a-f0-9]{64}$/);
        resolve({ code, stdout, stderr, ...(identity ? { identity } : {}) });
      } catch (error) { reject(error); }
    });
  });
  return { child, result };
}
async function command(args: string[]) { return (await start(args)).result; }
function actualRun(stdout: string) { return parseRunArtifact(JSON.parse(stdout)); }

test.each([
  ['postgres:16', 'postgresql16-native-v1'], ['postgres:17', 'postgresql17-native-v1'], ['postgres:18', 'postgresql18-native-v1'],
  ['pgvector/pgvector:0.8.6-pg17-bookworm', 'postgresql17-pgvector0.8.6-v1'],
])('managed doctor checks real %s and removes the exact owned server', async (image, profile) => {
  const result = await command(['doctor', '--docker', '--postgres-image', image!, ...(profile!.includes('pgvector') ? ['--fixture-profile', profile!] : []), '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const run = actualRun(result.stdout);
  expect(run.outcome).toBe('passed'); expect(run.environment.nodeVersion).toBe(process.version);
  expect(run.environment.fixture?.profile).toBe(profile); expect(run.trace.map(step => step.sql)).toEqual(['SELECT $1::int AS checked', 'SELECT $1::int AS checked']);
  expect(run.actors.map(actor => actor.value)).toEqual([1, 2]); expect(run.cleanup.complete).toBe(true);
  expect(result.stderr).toContain('Removed owned server and verified absence');
}, 240_000);

test('the explicit vector profile selects its managed image when no image was supplied', async () => {
  const result = await command(['doctor', '--docker', '--fixture-profile', 'postgresql17-pgvector0.8.6-v1', '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(actualRun(result.stdout).environment.fixture?.profile).toBe('postgresql17-pgvector0.8.6-v1');
  expect(result.stderr).toContain('Starting disposable pgvector/pgvector:0.8.6-pg17-bookworm');
}, 240_000);

test('closing the progress pipe during real managed startup still removes the owned server', async () => {
  const result = await (await start(['doctor', '--docker', '--json'], {}, true)).result;
  expect(result.code, result.stdout + result.stderr).toBe(2);
  expect(JSON.parse(result.stdout).error).toBeDefined();
  expect(result.stderr).toContain('Starting disposable');
}, 240_000);

test('human doctor describes exactly the environment in its saved artifact', async () => {
  const artifact = join(await directory(), 'doctor.json');
  const result = await command(['doctor', '--docker', '--out', artifact]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const run = actualRun(await readFile(artifact, 'utf8'));
  expect(result.stdout).toContain(`Node.js: ${run.environment.nodeVersion}`);
  expect(result.stdout).toContain(`PostgreSQL: ${run.environment.serverVersion}`);
  expect(result.stdout).toContain(`Fixture: ${run.environment.fixture!.profile}`);
}, 240_000);

test('packaged owned unsafe and safe demonstrations retain their actual outcomes with managed PostgreSQL', async () => {
  const unsafe = await command(['demo', '--docker', '--json']);
  expect(unsafe.code, unsafe.stdout + unsafe.stderr).toBe(1);
  const bad = actualRun(unsafe.stdout); expect(bad.outcome).toBe('violation'); expect(bad.trace).toHaveLength(10);
  expect(bad.failure).toBeDefined(); expect(bad.cleanup.complete).toBe(true);
  const safe = await command(['demo', '--docker', '--safe', '--json']);
  expect(safe.code, safe.stdout + safe.stderr).toBe(0);
  const good = actualRun(safe.stdout); expect(good.outcome).toBe('passed'); expect(good.cleanup.complete).toBe(true);
  expect(good.actors.map(actor => actor.value).sort()).toEqual(['held', 'insufficient']);
}, 240_000);

test('record, exact replay, reduction and report preserve real evidence across separate managed servers', async () => {
  const root = await directory(), artifact = join(root, 'original.json'), scenario = fixture('counter');
  const recorded = await command(['run', scenario, '--docker', '--out', artifact, '--plan', 'alice,bob,alice,bob', '--json']);
  expect(recorded.code, recorded.stdout + recorded.stderr).toBe(1);
  const bytes = await readFile(artifact), hash = createHash('sha256').update(bytes).digest('hex');
  const original = actualRun(bytes.toString()); expect(original.trace).toHaveLength(4);
  expect(original.environment.source?.components.runtime.files.some(file => file.path === 'dist/cli/managed-postgres.js')).toBe(true);
  const replayed = await command(['replay', scenario, artifact, '--docker', '--json']);
  expect(replayed.code, replayed.stdout + replayed.stderr).toBe(1);
  const repeat = actualRun(replayed.stdout); expect(repeat.failure).toEqual(original.failure); expect(repeat.environment).toEqual(original.environment);
  expect(repeat.trace.map(step => step.fingerprint)).toEqual(original.trace.map(step => step.fingerprint));
  const minimized = await command(['minimize', scenario, artifact, '--docker', '--json']);
  expect(minimized.code, minimized.stdout + minimized.stderr).toBe(1);
  const reduced = JSON.parse(minimized.stdout); expect(reduced.locallyMinimal).toBe(true); expect(reduced.reducedChoices).toBeLessThan(reduced.originalChoices);
  expect(reduced.run.failure).toEqual(original.failure); expect(reduced.run.trace).toHaveLength(4); expect(reduced.run.cleanup.complete).toBe(true);
  const refused = await command(['run', scenario, '--docker', '--out', artifact, '--json']);
  expect(refused.code).toBe(2); expect(JSON.parse(refused.stdout).error).toBeDefined();
  expect(createHash('sha256').update(await readFile(artifact)).digest('hex')).toBe(hash);
  const report = join(root, 'offline report.html');
  const rendered = await command(['report', artifact, '--out', report, '--json']);
  expect(rendered.code).toBe(0); expect(rendered.stderr).toBe(''); expect((await readFile(report, 'utf8')).length).toBeGreaterThan(1000);
}, 240_000);

test.each(['SIGINT', 'SIGTERM'] as const)('%s during an actual setup preserves its exit and removes the server', async signal => {
  const marker = join(await directory(), 'owned-database');
  const running = await start(['run', fixture('hung'), '--docker', '--timeout-ms', '30000', '--json'], { INTERLEAVE_CLI_TEST_MARKER: marker });
  try {
    const deadline = Date.now() + 180_000; let owned = '';
    while (!owned && Date.now() < deadline) { owned = await readFile(marker, 'utf8').catch(() => ''); if (!owned) await new Promise(resolve => setTimeout(resolve, 25)); }
    expect(owned).toMatch(/^interleave_[a-f0-9]+$/); running.child.kill(signal);
    const result = await running.result; expect(result.code, result.stdout + result.stderr).toBe(signal === 'SIGINT' ? 130 : 143);
    const search = JSON.parse(result.stdout); expect(search.stopReason).toBe('aborted'); expect(search.runs.every((run: { cleanup: { complete: boolean } }) => run.cleanup.complete)).toBe(true);
  } finally { running.child.kill('SIGTERM'); await running.result; }
}, 240_000);
