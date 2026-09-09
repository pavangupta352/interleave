import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { runScenarioFile } from '../src/supervised.js';
import { parseRunArtifact } from '../src/artifact.js';
import { testDatabaseUrl } from './helpers/postgres.js';

test.each(['cancel', 'deadline'] as const)('contains the real Postgres.js default-discovery %s rejection without passing evidence', async interruption => {
  const root = await mkdtemp(join(tmpdir(), 'interleave-pghybrid-discovery-'));
  const journal = join(root, 'owned.txt');
  const previous = process.env.PGHYBRID_OWNED_JOURNAL;
  process.env.PGHYBRID_OWNED_JOURNAL = journal;
  const controller = new AbortController();
  const databaseUrl = testDatabaseUrl();
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let names: string[] = [], settled = false;
  const readNames = () => readFile(journal, 'utf8').then(value => value.trim().split('\n').filter(Boolean), error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  const running = runScenarioFile(fileURLToPath(new URL('./fixtures/pghybrid/discovery-abort.mjs', import.meta.url)), {
    databaseUrl, fixtureProfile: 'postgresql17-pgvector0.8.6-v1', protocolProfile: 'describe-flush-v1',
    timeoutMs: 8000, signal: controller.signal,
  });
  void running.then(() => { settled = true; }, () => { settled = true; });
  try {
    let connected = false;
    const until = Date.now() + 7000;
    while (!settled && Date.now() < until) {
      names = await readNames();
      connected = (await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND application_name = 'pghybrid-adapter-qualification'", [names])).rowCount! > 0;
      if (connected) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(connected, 'The actual caller must connect before the intended interruption').toBe(true);
    if (interruption === 'cancel') controller.abort();
    const run = await running;
    console.log(JSON.stringify({ pghybridDiscoveryAbort: { interruption, outcome: run.outcome, reason: run.reason,
      traceSteps: run.trace.length, sourceBound: Boolean(run.environment.source), cleanup: run.cleanup } }));
    expect(connected, run.reason).toBe(true);
    expect(names).toHaveLength(1);
    expect(run.outcome).toBe('inconclusive');
    expect(run.reason).toMatch(interruption === 'cancel' ? /cancel/ : /deadline/);
    expect(run.reason).toMatch(/exit 1/);
    expect(run.trace).toEqual([]);
    expect(run.cleanup.complete).toBe(true);
    expect(parseRunArtifact(run)).toEqual(run);
  } finally {
    controller.abort(); await running;
    names = [...new Set([...names, ...await readNames()])];
    const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names])).rows;
    console.log(JSON.stringify({ pghybridDiscoveryCleanup: { names, remaining } }));
    await admin.end(); await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PGHYBRID_OWNED_JOURNAL;
    else process.env.PGHYBRID_OWNED_JOURNAL = previous;
    expect(remaining).toEqual([]);
  }
}, 20_000);
