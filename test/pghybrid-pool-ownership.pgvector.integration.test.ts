import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { expect, test } from 'vitest';
import { runScenarioFile } from '../src/supervised.js';
import { parseRunArtifact } from '../src/artifact.js';
import { testDatabaseUrl } from './helpers/postgres.js';
import { createOwnedDatabase } from '../src/database.js';
import { observePoolClients } from '../examples/pghybrid/adapters.js';
import { CONFIG, EMBEDDING, QUERY, createPghybridScenario } from '../examples/pghybrid/scenario.js';
import { forKysely } from '../examples/pghybrid/vendor/pghybrid/dist/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Expected public client lifecycle event was not observed')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

test.each(['late-connect', 'checked-out-error'] as const)('owns the real Kysely caller through %s', async boundary => {
  const database = await createOwnedDatabase(testDatabaseUrl());
  const factory = deferred(); const allowConnect = deferred(); const reserved = deferred(); const ended = deferred();
  const events: string[] = []; const errors: Error[] = [];
  const pool = new Pool({ connectionString: database.connectionString, max: 1, application_name: 'pghybrid-owned-client' });
  const lifecycle = observePoolClients(pool, error => { errors.push(error); events.push('client-error'); lifecycle.interrupt(); });
  pool.on('error', error => { errors.push(error); lifecycle.interrupt(); });
  pool.on('connect', client => {
    events.push('connect'); client.once('end', () => { events.push('end'); ended.resolve(); });
  });
  pool.on('acquire', () => events.push('acquire'));
  const db = new Kysely({ dialect: new PostgresDialect({
    async pool() { factory.resolve(); await allowConnect.promise; return pool; },
    async onReserveConnection() { events.push('reserved'); reserved.resolve(); await ended.promise; events.push('released-hook'); },
  }) });
  let search: Promise<unknown> | undefined;
  try {
    await createPghybridScenario().setup(database);
    search = forKysely(db, CONFIG).search(QUERY, { embedding: EMBEDDING, limit: 3 });
    const rejected = expect(search).rejects.toThrow(/closed|terminated|queryable/i);
    await bounded(factory.promise);
    if (boundary === 'late-connect') {
      events.push('interrupt'); lifecycle.interrupt(); allowConnect.resolve();
    } else {
      allowConnect.resolve(); await bounded(reserved.promise);
      const backends = (await database.db.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name='pghybrid-owned-client'", [database.name])).rows;
      expect(backends).toHaveLength(1);
      expect((await database.db.query('SELECT pg_terminate_backend($1) AS terminated', [backends[0].pid])).rows).toEqual([{ terminated: true }]);
    }
    await bounded(rejected);
    // Destroy only after the real acquire/action path unwinds and releases.
    await bounded(db.destroy()); await bounded(lifecycle.waitForEnd());
    if (boundary === 'late-connect') {
      expect(events).toHaveLength(6);
      expect(events.slice(0, 3)).toEqual(['interrupt', 'connect', 'acquire']);
      expect(events.slice(3, 5).sort()).toEqual(['end', 'reserved']);
      expect(events[5]).toBe('released-hook');
    } else expect(events).toEqual(['connect', 'acquire', 'reserved', 'client-error', 'end', 'released-hook']);
    if (boundary === 'late-connect') expect(errors).toEqual([]);
    else expect(errors).toMatchObject([{ code: '57P01' }]);
    expect(pool.totalCount).toBe(0);
    console.log(JSON.stringify({ pghybridPoolOwnership: { boundary, events, errors: errors.map(error => error.message) } }));
  } finally {
    allowConnect.resolve(); lifecycle.interrupt();
    try {
      try { if (search) await bounded(search.catch(() => {})); }
      finally { await bounded(db.destroy()); await bounded(lifecycle.waitForEnd()); }
    }
    finally {
      const name = database.name; await database.close();
      const admin = new Client({ connectionString: testDatabaseUrl() }); await admin.connect();
      try {
        const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows;
        console.log(JSON.stringify({ pghybridPoolOwnershipCleanup: { names: [name], remaining } }));
        expect(remaining).toEqual([]);
      } finally { await admin.end(); }
    }
  }
});

test('public Kysely acquisition cancellation owns the checked-out Client through its actual end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interleave-pghybrid-kysely-'));
  const journal = join(root, 'events.jsonl');
  const previous = process.env.PGHYBRID_KYSELY_JOURNAL;
  process.env.PGHYBRID_KYSELY_JOURNAL = journal;
  const controller = new AbortController();
  const databaseUrl = testDatabaseUrl();
  const admin = new Client({ connectionString: databaseUrl });
  const events = () => readFile(journal, 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  let settled = false;
  const running = runScenarioFile(fileURLToPath(new URL('./fixtures/pghybrid/kysely-acquisition-abort.mjs', import.meta.url)), {
    databaseUrl, fixtureProfile: 'postgresql17-pgvector0.8.6-v1', timeoutMs: 30_000, signal: controller.signal,
  });
  void running.then(() => { settled = true; }, () => { settled = true; });
  try {
    await admin.connect();
    let reserved = false;
    const deadline = Date.now() + 25_000;
    while (!settled && Date.now() < deadline) {
      reserved = (await events()).some(event => event.event === 'reserve-hook-entered');
      if (reserved) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(reserved, 'the actual public acquisition hook must precede cancellation').toBe(true);
    controller.abort();
    const run = await running;
    const observed = await events();
    console.log(JSON.stringify({ pghybridKyselyAcquisition: { outcome: run.outcome, reason: run.reason,
      actors: run.actors, events: observed, cleanup: run.cleanup } }));
    expect(run.outcome, run.reason).toBe('inconclusive');
    expect(run.reason).toMatch(/cancel/i);
    expect(run.reason).not.toMatch(/worker.*exit/i);
    expect(run.actors.find(actor => actor.actor === 'first')?.status).toBe('rejected');
    expect(observed.map(event => event.event)).toEqual(['setup', 'pool-connect', 'pool-acquire', 'reserve-hook-entered',
      'caller-abort', 'client-end', 'reserve-hook-completed', 'caller-closed']);
    expect(run.trace).toEqual([]);
    expect(run.cleanup.complete).toBe(true);
    expect(parseRunArtifact(run)).toEqual(run);
  } finally {
    controller.abort();
    try {
      try { await running; }
      finally {
        const names = (await events()).filter(event => event.event === 'setup').map(event => event.database);
        const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [names])).rows;
        console.log(JSON.stringify({ pghybridKyselyAcquisitionCleanup: { names, remaining } }));
        expect(names).toHaveLength(1); expect(remaining).toEqual([]);
      }
    } finally {
      try { await admin.end(); }
      finally {
        try { await rm(root, { recursive: true, force: true }); }
        finally {
          if (previous === undefined) delete process.env.PGHYBRID_KYSELY_JOURNAL;
          else process.env.PGHYBRID_KYSELY_JOURNAL = previous;
        }
      }
    }
  }
}, 40_000);
