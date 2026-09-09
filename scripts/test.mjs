#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [suite = 'all', ...argumentsForVitest] = process.argv.slice(2);
if (!['all', 'unit', 'integration', 'browser'].includes(suite)) {
  console.error('[test] Expected test suite: all, unit, integration, or browser.');
  process.exit(1);
}
const image = 'postgres:16';
const ownerLabel = 'io.interleave.test-run';
let managed;
let interrupted;
let vitest;
let escalation;
let exitCode = 1;

function signalExitCode(signal) { return 128 + (constants.signals[signal] ?? 1); }
function terminateTests(signal) {
  if (!vitest?.pid) return;
  try {
    if (process.platform === 'win32') vitest.kill(signal);
    else process.kill(-vitest.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') vitest.kill(signal); }
}
function onSignal(signal) {
  if (interrupted) return;
  interrupted = signal;
  console.error(`[test] ${signal} received; stopping tests and cleaning up the owned test server.`);
  terminateTests(signal);
  if (vitest) escalation = setTimeout(() => terminateTests('SIGKILL'), 3_000);
  // An in-flight Docker create/start is awaited before cleanup. Abandoning its
  // response could lose the container that the daemon is still creating.
}
const onInterrupt = () => onSignal('SIGINT');
const onTerminate = () => onSignal('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
function checkInterrupted() { if (interrupted) throw new Error('Test run was cancelled'); }

async function docker(args, { timeout = 15_000, env = process.env } = {}) {
  return (await execute('docker', args, { cwd: repository, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
}

async function createTestServer() {
  try { await docker(['info', '--format', '{{.ServerVersion}}']); }
  catch (error) {
    throw new Error(error.code === 'ENOENT'
      ? 'Docker CLI was not found. Install and start Docker, or set TEST_DATABASE_URL to a dedicated PostgreSQL administrator database. Unit tests need neither: npm run test:unit.'
      : 'Docker is unavailable. Start Docker and check its engine access, or set TEST_DATABASE_URL to a dedicated PostgreSQL administrator database. Unit tests need neither: npm run test:unit.');
  }
  checkInterrupted();
  const owner = randomUUID();
  const name = `interleave-test-${owner}`;
  const password = randomBytes(24).toString('hex');
  managed = { owner, name, id: undefined };
  console.error(`[test] Starting disposable ${image} server (${name}).`);
  let phase = 'create the container or download its image';
  try {
    // Docker reads POSTGRES_PASSWORD from its environment. It is never placed in
    // command arguments, test progress, or the container's ownership label.
    const id = await docker([
      'create', '--pull=missing', '--name', name, '--label', `${ownerLabel}=${owner}`,
      '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=postgres',
      '--env', 'POSTGRES_DB=postgres', '--health-cmd', 'pg_isready -U postgres -d postgres',
      '--health-interval', '1s', '--health-timeout', '5s', '--health-retries', '60',
      image,
    ], { timeout: 180_000, env: { ...process.env, POSTGRES_PASSWORD: password } });
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker returned an invalid container identity');
    managed.id = id;
    checkInterrupted();
    phase = 'start the container';
    await docker(['start', id]);
    phase = 'wait for PostgreSQL health';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      checkInterrupted();
      const status = await docker(['inspect', '--format', '{{.State.Status}} {{.State.Health.Status}}', id]);
      if (status === 'running healthy') {
        const binding = await docker(['port', id, '5432/tcp']);
        const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
        if (!match) throw new Error('Docker did not return the expected loopback-only PostgreSQL port');
        console.error('[test] Disposable PostgreSQL is ready; running tests.');
        return `postgresql://postgres:${password}@127.0.0.1:${match[1]}/postgres`;
      }
      if (status.startsWith('exited ') || status.endsWith(' unhealthy')) throw new Error('PostgreSQL failed its container health check');
      await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
    }
    throw new Error('PostgreSQL did not become healthy within 90 seconds');
  } catch (error) {
    if (interrupted) throw error;
    throw new Error(`Could not ${phase} for disposable PostgreSQL. Check Docker engine access, available resources, and access to the official ${image} image.`);
  }
}

async function cleanupTestServer() {
  if (!managed) return;
  let identity;
  try {
    identity = await docker(['inspect', '--format', `{{.Id}} {{index .Config.Labels "${ownerLabel}"}}`, managed.id ?? managed.name]);
  } catch (error) {
    // Docker distinguishes an absent container from a daemon/transport failure.
    if (/No such (object|container)/i.test(error.stderr ?? '')) return;
    throw new Error(`Could not verify cleanup ownership for ${managed.name}. Restore Docker access and check this exact test container.`);
  }
  const [id, owner] = identity.split(' ');
  if (!/^[a-f0-9]{64}$/.test(id ?? '') || owner !== managed.owner || (managed.id && id !== managed.id)) {
    throw new Error(`Refusing cleanup because ownership did not match ${managed.name}.`);
  }
  try { await docker(['rm', '--force', '--volumes', id], { timeout: 30_000 }); }
  catch { throw new Error(`Could not remove owned test container ${managed.name}. Restore Docker access and check this exact container.`); }
  console.error(`[test] Removed owned test server (${managed.name}).`);
}

async function runVitest(databaseUrl) {
  checkInterrupted();
  const env = { ...process.env, INTERLEAVE_TEST_SUITE: suite };
  if (databaseUrl) { env.TEST_DATABASE_URL = databaseUrl; env.INTERLEAVE_TEST_DATABASE_URL = databaseUrl; }
  const entry = suite === 'browser' ? resolve(repository, 'test/browser/run.mjs')
    : fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')));
  return await new Promise(resolveExit => {
    vitest = spawn(process.execPath, [entry, ...(suite === 'browser' ? [] : ['run']), ...argumentsForVitest], {
      cwd: repository, env, stdio: 'inherit', detached: process.platform !== 'win32',
    });
    vitest.once('error', () => { console.error('[test] Could not start the test runner. Run npm ci to install development dependencies.'); resolveExit(1); });
    vitest.once('exit', (code, signal) => {
      if (escalation) clearTimeout(escalation);
      vitest = undefined;
      resolveExit(code ?? signalExitCode(signal));
    });
  });
}

try {
  let databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.INTERLEAVE_TEST_DATABASE_URL;
  if (suite !== 'unit') {
    if (databaseUrl !== undefined && !databaseUrl.trim()) throw new Error('TEST_DATABASE_URL must be a non-empty dedicated PostgreSQL administrator URL.');
    if (!databaseUrl) databaseUrl = await createTestServer();
    else console.error('[test] Using the explicitly supplied dedicated PostgreSQL test server.');
  }
  exitCode = await runVitest(databaseUrl);
} catch (error) {
  if (!interrupted) console.error(`[test] ${error.message}`);
  exitCode = interrupted ? signalExitCode(interrupted) : 1;
} finally {
  if (escalation) clearTimeout(escalation);
  try { await cleanupTestServer(); }
  catch (error) { console.error(`[test] ${error.message}`); if (exitCode === 0) exitCode = 1; }
  if (interrupted) exitCode = signalExitCode(interrupted);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
process.exitCode = exitCode;
