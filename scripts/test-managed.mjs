import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This explicit suite provisions its own CLI-owned servers. Ordinary unit tests
// and supplied-server integration jobs never require an additional Docker daemon.
const control = await mkdtemp(join(tmpdir(), 'interleave-managed-tests-'));
const stopFile = join(control, 'stop');
let interrupted;
function stop(signal) {
  if (interrupted) return;
  interrupted = signal;
  // Ask the test-owned CLI children to stop through their public signal handler.
  // Sending a signal to the whole process group would also interrupt Docker's
  // in-flight create reply, losing the lifecycle's normal ownership handoff.
  try { writeFileSync(stopFile, signal, { flag: 'wx', mode: 0o600 }); }
  catch { console.error('Could not deliver the stop request; awaiting managed test cleanup.'); }
}
const onInterrupt = () => stop('SIGINT'), onTerminate = () => stop('SIGTERM');
process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
const env = { ...process.env, INTERLEAVE_TEST_MANAGED_POSTGRES: '1', INTERLEAVE_TEST_SUITE: 'integration', INTERLEAVE_MANAGED_STOP_FILE: stopFile };
delete env.TEST_DATABASE_URL; delete env.INTERLEAVE_TEST_DATABASE_URL;
try {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', 'test/cli.managed.integration.test.ts', '--bail=1', ...process.argv.slice(2)], { env, stdio: 'inherit' });
  const code = await new Promise(resolve => {
    child.once('error', () => { console.error('Could not start managed PostgreSQL qualification. Run npm ci first.'); resolve(1); });
    child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
  });
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : code;
} finally {
  await rm(control, { recursive: true, force: true });
  process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
}
