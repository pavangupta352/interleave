import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This explicit suite provisions its own CLI-owned servers. Ordinary unit tests
// and supplied-server integration jobs never require an additional Docker daemon.
const env = { ...process.env, INTERLEAVE_TEST_MANAGED_POSTGRES: '1', INTERLEAVE_TEST_SUITE: 'integration' };
delete env.TEST_DATABASE_URL; delete env.INTERLEAVE_TEST_DATABASE_URL;
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', 'test/cli.managed.integration.test.ts', ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.once('error', () => { console.error('Could not start managed PostgreSQL qualification. Run npm ci first.'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); });
