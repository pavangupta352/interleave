import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { testDatabaseUrl } from './helpers/postgres.js';

test.each([true, false])('contains and drains real transaction replay/step-limit interruption (prepare %s)', async prepare => {
  const databaseUrl = testDatabaseUrl(), owned = new Set<string>();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/postgresjs-shutdown.mjs', import.meta.url)), String(prepare)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TEST_DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '', stderr = '', successful = false;
  child.stdout!.on('data', chunk => { stdout += chunk; if (stdout.length > 100_000) child.kill('SIGKILL'); });
  child.stderr!.on('data', chunk => { stderr += chunk; if (stderr.length > 100_000) child.kill('SIGKILL'); });
  child.on('message', message => { if (typeof message === 'object' && message !== null && 'owned' in message && typeof message.owned === 'string') owned.add(message.owned); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(exit, stderr).toEqual({ code: 0, signal: null });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ prepare, outcomes: Array.from({ length: 3 }, () => ['passed', 'incompatible', 'inconclusive']).flat(), bufferedFailure: true });
    successful = true;
  } finally {
    clearTimeout(timer); child.kill('SIGKILL');
    const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
    try {
      const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [[...owned]])).rows;
      for (const { datname } of remaining) { assert.match(datname, /^interleave_[0-9a-f]{32}$/); await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`); }
      if (successful) expect(remaining).toEqual([]);
    } finally { await admin.end(); }
  }
}, 25_000);
