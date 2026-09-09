import { Client } from 'pg';
import net from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { createPghybridAdapterScenario, pghybridAdapterOptions, type PghybridAdapter } from '../examples/pghybrid/adapters.js';
import { runOnce } from '../src/runner.js';
import { parseRunArtifact } from '../src/artifact.js';
import * as proxyModule from '../src/proxy.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const adapters: PghybridAdapter[] = ['pg-pool', 'pg-client', 'postgresjs', 'drizzle', 'kysely'];
const owned: string[] = [];

function tracked(input: Scenario): Scenario {
  return { ...input, async setup(context) {
    owned.push(decodeURIComponent(new URL(context.connectionString).pathname.slice(1)));
    await input.setup(context);
  } };
}
afterEach(async () => {
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  try {
    const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [owned])).rows;
    console.log(JSON.stringify({ pghybridAdapterCleanup: { names: [...owned], remaining } }));
    expect(remaining).toEqual([]);
  } finally { owned.length = 0; await admin.end(); }
});

test('handled real Pool query waits for proxy retirement before replacing its closed client', async () => {
  const events: string[] = [];
  let releaseClose: (() => void) | undefined;
  let firstServer = true;
  const createServer = net.createServer.bind(net);
  const spy = vi.spyOn(net, 'createServer').mockImplementation(((...args: Parameters<typeof net.createServer>) => {
    const server = createServer(...args);
    if (!firstServer) return server;
    firstServer = false;
    let firstConnection = true;
    // Register after the production connection listener so the replacement
    // reaches admission while the real old close notification is still queued.
    server.on('connection', socket => {
      if (!firstConnection) {
        events.push('replacement TCP connection reached proxy');
        releaseClose?.(); releaseClose = undefined;
        return;
      }
      firstConnection = false;
      const emit = socket.emit;
      socket.emit = ((event: string | symbol, ...values: unknown[]) => {
        if (event === 'close' && !releaseClose) {
          expect(socket.destroyed).toBe(true);
          events.push('old proxy frontend physically closed; notification queued');
          releaseClose = () => { events.push('old proxy close notification delivered'); Reflect.apply(emit, socket, [event, ...values]); };
          return true;
        }
        return Reflect.apply(emit, socket, [event, ...values]);
      }) as typeof socket.emit;
    });
    return server;
  }) as typeof net.createServer);
  try {
    const run = await runOnce(tracked(createPghybridAdapterScenario('pg-pool', 'handled-error')), {
      databaseUrl, ...pghybridAdapterOptions('pg-pool'), timeoutMs: 10_000,
    });
    console.log(JSON.stringify({ poolRetirementReproduction: { events, outcome: run.outcome,
      reason: run.reason, connections: run.connections?.map(item => [item.actor, item.connection]),
      completionCodes: run.trace.map(step => step.completion?.error?.code ?? 'ok'), cleanup: run.cleanup } }));
    expect(events).toEqual(['old proxy frontend physically closed; notification queued',
      'replacement TCP connection reached proxy', 'old proxy close notification delivered']);
    expect(run.outcome, run.reason).toBe('passed');
    expect(run.connections).toHaveLength(4);
    expect(run.cleanup.complete).toBe(true);
  } finally { releaseClose?.(); spy.mockRestore(); }
});

test.each(adapters)('%s public searches reuse, reconnect and exactly replay through the real adapter', async adapter => {
  const scenario = tracked(createPghybridAdapterScenario(adapter, 'reconnect'));
  const options = { databaseUrl, ...pghybridAdapterOptions(adapter), timeoutMs: 30_000 };
  const first = await runOnce(scenario, options);
  expect(first.outcome, first.reason).toBe('passed');
  expect(first.connections?.map(item => [item.actor, item.connection]).sort()).toEqual([
    ['first', 0], ['first', 1], ['second', 0], ['second', 1],
  ]);
  expect(first.trace.filter(step => step.sql.includes('websearch_to_tsquery') && step.completion?.kind !== 'metadata')).toHaveLength(6);
  if (adapter === 'postgresjs') {
    expect(first.schemaVersion).toBe(2);
    expect(first.trace.some(step => step.sql.includes('pg_catalog.pg_type'))).toBe(true);
    expect(first.trace.filter(step => step.sql.includes('websearch_to_tsquery') && step.stage === 'describe')).toHaveLength(6);
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    const replayed = await runOnce(scenario, { ...options, replay: first });
    expect(replayed.outcome, replayed.reason).toBe('passed');
    expect(replayed.environment.fixture).toEqual(first.environment.fixture);
    expect(replayed.connections).toEqual(first.connections);
    expect(replayed.trace.map(step => step.fingerprint)).toEqual(first.trace.map(step => step.fingerprint));
    expect(replayed.actors).toEqual(first.actors);
    expect(replayed.cleanup.complete).toBe(true);
  }
  expect(first.cleanup.complete).toBe(true);
});

test.each(adapters)('%s propagates real SQL errors and recovers through its actual public caller', async adapter => {
  for (const behavior of ['handled-error', 'unhandled-error'] as const) {
    let invariants = 0;
    const original = createPghybridAdapterScenario(adapter, behavior);
    const scenario = tracked({ ...original, async invariant(context) { invariants++; await original.invariant(context); } });
    const run = await runOnce(scenario, { databaseUrl, ...pghybridAdapterOptions(adapter), timeoutMs: 30_000 });
    expect(run.outcome, run.reason).toBe(behavior === 'handled-error' ? 'passed' : 'actor-error');
    expect(run.trace.some(step => step.completion?.error?.code === '42P01')).toBe(true);
    if (behavior === 'handled-error') {
      const replaced = adapter === 'pg-pool' || adapter === 'drizzle';
      expect(run.connections).toHaveLength(replaced ? 4 : 2);
      expect(run.trace.filter(step => step.completion?.error?.code === '42P01' && step.completion.kind !== 'metadata')).toHaveLength(2);
    }
    expect(invariants).toBe(behavior === 'handled-error' ? 1 : 0);
    expect(run.cleanup.complete).toBe(true);
    expect(parseRunArtifact(run)).toEqual(run);
  }
});

test('the actual Postgres.js public search fails closed in the default whole-cycle profile', async () => {
  const original = createPghybridAdapterScenario('postgresjs');
  const run = await runOnce(tracked({ ...original, actors: { first: original.actors.first!, async second() {} } }), {
    databaseUrl, fixtureProfile: 'postgresql17-pgvector0.8.6-v1', timeoutMs: 10_000,
  });
  expect(run.outcome, run.reason).toBe('inconclusive');
  expect(run.reason).toMatch(/unsupported.*(flush|H)/i);
  expect(run.trace.some(step => step.sql.includes('websearch_to_tsquery'))).toBe(false);
  expect(run.cleanup.complete).toBe(true);
});

test('actual changed document data is incompatible before any adapter query is released', async () => {
  const original = createPghybridAdapterScenario('drizzle');
  const options = { databaseUrl, ...pghybridAdapterOptions('drizzle'), timeoutMs: 30_000 };
  const first = await runOnce(tracked(original), options);
  expect(first.outcome, first.reason).toBe('passed');
  const changed = await runOnce(tracked({ ...original, async setup(context) {
    await original.setup(context);
    await context.db.query("UPDATE adapter_fixture SET content = content || ' changed qualification input' WHERE title = 'Renewal terms'");
  } }), { ...options, replay: first });
  expect(changed.outcome, changed.reason).toBe('incompatible');
  expect(changed.reason).toMatch(/fixture/i);
  expect(changed.trace).toEqual([]);
  expect(changed.cleanup.complete).toBe(true);
});

test.each(adapters)('%s closes a pending real search on cancellation and deadline', async adapter => {
  for (const interruption of ['cancel', 'deadline'] as const) {
    const controller = new AbortController();
    let searchQueued = false;
    const createProxy = proxyModule.createProxy;
    const observation = vi.spyOn(proxyModule, 'createProxy').mockImplementation(options => createProxy({
      ...options, onUnit(unit) {
        if (unit.actor === 'first' && unit.sql.includes('websearch_to_tsquery')) searchQueued = true;
        options.onUnit(unit);
      },
    }));
    const original = createPghybridAdapterScenario(adapter);
    const scenario = tracked({ ...original, actors: { first: original.actors.first!, async second({ connectionString }) {
      if (adapter === 'postgresjs') {
        // Let default type discovery complete before holding the public search.
        const client = new Client({ connectionString }); await client.connect();
        try { await client.query('SELECT 1'); } finally { await client.end(); }
      }
      await new Promise(() => {});
    } } });
    const running = runOnce(scenario, { databaseUrl, ...pghybridAdapterOptions(adapter), signal: controller.signal,
      timeoutMs: interruption === 'deadline' ? 2000 : 10_000 });
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    const admin = new Client({ connectionString: databaseUrl });
    let ready = false;
    try {
      await admin.connect();
      const until = Date.now() + 5000;
      while (!settled && Date.now() < until) {
        ready = (await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND application_name = 'pghybrid-adapter-qualification' AND ($2::boolean = false OR (query LIKE '%pg_catalog.pg_type%' AND state = 'idle'))", [owned, adapter === 'postgresjs'])).rowCount! > 0 && searchQueued;
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(ready, 'the actual queued search and its backend must precede interruption').toBe(true);
      if (interruption === 'cancel') controller.abort();
      const run = await running;
      console.log(JSON.stringify({ pghybridAdapterInterruption: { adapter, interruption, searchQueued,
        outcome: run.outcome, reason: run.reason, actors: run.actors, cleanup: run.cleanup } }));
      expect(run.outcome, run.reason).toBe('inconclusive');
      expect(run.reason).toMatch(interruption === 'cancel' ? /cancel/i : /deadline/i);
      if (adapter === 'postgresjs') {
        expect(run.trace.some(step => step.sql.includes('pg_catalog.pg_type') && step.completion)).toBe(true);
        expect(run.trace.some(step => step.sql.includes('websearch_to_tsquery'))).toBe(false);
      } else expect(run.trace).toEqual([]);
      expect(run.actors.find(actor => actor.actor === 'first')?.status).toBe('rejected');
      expect(run.cleanup.complete).toBe(true);
      expect(parseRunArtifact(run)).toEqual(run);
    } finally {
      controller.abort();
      try { await running; }
      finally { try { await admin.end(); } finally { observation.mockRestore(); } }
    }
  }
});
