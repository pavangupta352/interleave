import { appendFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import { createOrmScenario, type Orm } from '../examples/orm/scenario.js';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import { minimize } from '../src/minimize.js';
import { parseRunArtifact } from '../src/artifact.js';
import * as proxyModule from '../src/proxy.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const orms: Orm[] = ['drizzle', 'kysely'];
const owned: string[] = [];
async function journal(record: object): Promise<void> {
  const path = process.env.INTERLEAVE_ORM_JOURNAL;
  if (path) await appendFile(path, `${JSON.stringify(record)}\n`);
}
function tracked(scenario: Scenario): Scenario {
  return { ...scenario, async setup(context) {
    owned.push(new URL(context.connectionString).pathname.slice(1));
    await scenario.setup(context);
  } };
}
afterEach(async () => {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [owned])).rows;
    console.log(JSON.stringify({ ordinaryOrmCleanup: { names: [...owned], remaining } }));
    await journal({ event: 'cleanup', names: [...owned], remaining });
    expect(remaining).toEqual([]);
  } finally { owned.length = 0; await admin.end(); }
});

test.each(orms)('%s public SELECT and UPDATE expose the actual lost update', async orm => {
  const run = await runOnce(tracked(createOrmScenario(orm)), { databaseUrl, plan: ['alice', 'bob', 'alice', 'bob'] });
  console.log(JSON.stringify({ ordinaryOrm: { orm, run } }));
  await journal({ event: 'lost-update', orm, run });
  expect(run.outcome, run.reason).toBe('violation');
  expect(run.failure?.message).toContain('Expected both increments');
  expect(run.actors.map(actor => actor.value)).toEqual([{ read: 0, written: 1 }, { read: 0, written: 1 }]);
  expect(run.trace).toHaveLength(4);
  expect(run.trace.map(step => step.actor)).toEqual(['alice', 'bob', 'alice', 'bob']);
  expect(run.trace.every(step => step.protocol === 'extended' && step.sql.includes('$1') && step.completion?.rowCount === 1)).toBe(true);
  expect(run.cleanup.complete).toBe(true);
});

test.each(orms)('%s exactly replays and minimizes the same observed invariant failure', async orm => {
  const scenario = tracked(createOrmScenario(orm));
  const first = await runOnce(scenario, { databaseUrl, plan: ['alice', 'bob', 'alice', 'bob'] });
  expect(first.outcome, first.reason).toBe('violation');
  for (let attempt = 0; attempt < 2; attempt++) {
    const repeated = await replay(scenario, first, { databaseUrl });
    await journal({ event: 'lost-update-exact', orm, run: repeated });
    expect(repeated.outcome, repeated.reason).toBe('violation');
    expect(repeated.failure).toEqual(first.failure);
    expect(repeated.actors).toEqual(first.actors);
    expect(repeated.trace.map(step => [step.actor, step.fingerprint])).toEqual(first.trace.map(step => [step.actor, step.fingerprint]));
    expect(repeated.cleanup.complete).toBe(true);
  }
  const reduced = await minimize(scenario, first, { databaseUrl, maxAttempts: 12 });
  await journal({ event: 'lost-update-minimize', orm, reduced });
  expect(reduced.stopReason).toBe('locally-minimal');
  expect(reduced.reducedChoices).toBeLessThan(reduced.originalChoices);
  expect(reduced.run.outcome).toBe('violation');
  expect(reduced.run.failure).toEqual(first.failure);
  expect(reduced.run.trace).toHaveLength(4);
  expect(reduced.run.cleanup.complete).toBe(true);
  expect(parseRunArtifact(reduced.run)).toEqual(reduced.run);
});

test.each(orms)('%s atomic public UPDATE retains both increments', async orm => {
  const run = await runOnce(tracked(createOrmScenario(orm, 'atomic')), { databaseUrl, plan: ['alice', 'bob'] });
  await journal({ event: 'atomic', orm, run });
  expect(run.outcome, run.reason).toBe('passed');
  expect(run.actors.map(actor => actor.value)).toEqual([{ written: 1 }, { written: 2 }]);
  expect(run.trace).toHaveLength(2);
  expect(run.trace.every(step => /^update /i.test(step.sql) && step.completion?.rowCount === 1)).toBe(true);
  expect(run.cleanup.complete).toBe(true);
});

test.each(orms)('%s commits CRUD, rolls back real 23505 and queries successfully afterwards', async orm => {
  const run = await runOnce(tracked(createOrmScenario(orm, 'crud-rollback')), { databaseUrl });
  await journal({ event: 'crud-rollback', orm, run });
  expect(run.outcome, run.reason).toBe('passed');
  expect(run.actors.map(actor => actor.value)).toEqual(Array.from({ length: 2 }, () => ({ inserted: 1, updated: 2, committed: 2, code: '23505', rolledBack: true, deleted: 2 })));
  const errors = run.trace.filter(step => step.completion?.error);
  expect(errors).toHaveLength(2);
  expect(errors.every(step => step.completion?.error?.code === '23505' && step.completion.transactionStatus === 'E')).toBe(true);
  expect(run.trace.filter(step => /^rollback$/i.test(step.sql)).map(step => step.completion?.transactionStatus)).toEqual(['I', 'I']);
  expect(run.trace.filter(step => /^commit$/i.test(step.sql)).map(step => step.completion?.transactionStatus)).toEqual(['I', 'I']);
  expect(run.connections?.map(connection => connection.actor).sort()).toEqual(['alice', 'bob']);
  expect(run.cleanup.complete).toBe(true);
  expect(parseRunArtifact(run)).toEqual(run);
});

for (const orm of orms) test.each([true, false])(`${orm} accepts a serial schedule without a retry, retry=%s`, async retry => {
  const run = await runOnce(tracked(createOrmScenario(orm, retry ? 'serializable-retry' : 'serializable-error')), {
    databaseUrl, plan: [...Array<string>(5).fill('alice'), ...Array<string>(5).fill('bob')],
  });
  await journal({ event: 'serializable-no-conflict', orm, retry, run });
  expect(run.outcome, run.reason ?? run.failure?.message).toBe('passed');
  expect(run.trace.map(step => step.actor)).toEqual([...Array<string>(5).fill('alice'), ...Array<string>(5).fill('bob')]);
  expect(run.trace.every(step => !step.completion?.error)).toBe(true);
  expect(run.actors.map(actor => actor.value)).toEqual([
    { attempts: 1, reads: [0], errors: [], rollbackVerified: false },
    { attempts: 1, reads: [1], errors: [], rollbackVerified: false },
  ]);
  expect(run.cleanup.complete).toBe(true);
});

for (const orm of orms) test.each([true, false])(`${orm} preserves real 40001 and whole-transaction retry=%s`, async retry => {
  const original = createOrmScenario(orm, retry ? 'serializable-retry' : 'serializable-error');
  const invariant = vi.fn(original.invariant);
  const scenario = tracked({ ...original, invariant });
  const first = await runOnce(scenario, { databaseUrl,
    plan: ['alice', 'bob', 'alice', 'bob', 'alice', 'bob', 'alice', 'bob', 'alice'] });
  const check = (run: Awaited<ReturnType<typeof runOnce>>) => {
    expect(run.outcome, run.reason).toBe(retry ? 'passed' : 'actor-error');
    expect(run.failure).toBeUndefined();
    const errors = run.trace.filter(step => step.completion?.error);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ actor: 'bob', completion: { transactionStatus: 'E', error: { code: '40001' } } });
    expect(errors[0]!.waits.some(wait => wait.waitEventType === 'Lock')).toBe(true);
    expect(run.trace.filter(step => /^rollback$/i.test(step.sql))).toMatchObject([{ actor: 'bob', completion: { transactionStatus: 'I' } }]);
    expect(run.actors.find(actor => actor.actor === 'alice')?.value).toEqual({ attempts: 1, reads: [0], errors: [], rollbackVerified: false });
    const bob = run.actors.find(actor => actor.actor === 'bob');
    if (retry) expect(bob?.value).toEqual({ attempts: 2, reads: [0, 1], errors: ['40001'], rollbackVerified: true });
    else expect(bob?.status).toBe('rejected');
    expect(run.cleanup.complete).toBe(true);
    expect(parseRunArtifact(run)).toEqual(run);
  };
  await journal({ event: 'serializable-record', orm, retry, run: first });
  check(first);
  expect(invariant).toHaveBeenCalledTimes(retry ? 1 : 0);
  const repeated = await replay(scenario, first, { databaseUrl });
  await journal({ event: 'serializable-exact', orm, retry, run: repeated });
  check(repeated);
  expect(invariant).toHaveBeenCalledTimes(retry ? 2 : 0);
  expect(repeated.trace.map(step => [step.actor, step.fingerprint])).toEqual(first.trace.map(step => [step.actor, step.fingerprint]));
  expect(repeated.actors).toEqual(first.actors);
});

for (const orm of orms) test.each(['cancel', 'deadline'] as const)(`${orm} closes a queued public query on %s`, async interruption => {
  const controller = new AbortController();
  let queryQueued = false;
  const createProxy = proxyModule.createProxy;
  const observer = vi.spyOn(proxyModule, 'createProxy').mockImplementation(options => createProxy({
    ...options, onUnit(unit) {
      if (unit.actor === 'alice' && /select .*counter/i.test(unit.sql)) queryQueued = true;
      options.onUnit(unit);
    },
  }));
  const original = createOrmScenario(orm);
  const scenario = tracked({ ...original, actors: {
    alice: original.actors.alice!,
    async bob({ signal }) {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  } });
  const running = runOnce(scenario, { databaseUrl, signal: controller.signal, timeoutMs: interruption === 'deadline' ? 2000 : 10_000 });
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  const admin = new Client({ connectionString: databaseUrl });
  try {
    await admin.connect();
    const until = Date.now() + 5000;
    let ready = false;
    while (!settled && Date.now() < until) {
      const observed = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND application_name = 'interleave-ordinary-orm'", [owned]);
      if (queryQueued && observed.rowCount! > 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(ready, 'A real queued ORM query and its backend must precede interruption').toBe(true);
    if (interruption === 'cancel') controller.abort();
    const run = await running;
    await journal({ event: 'interruption', orm, interruption, queryQueued, ready, run });
    expect(run.outcome, run.reason).toBe('inconclusive');
    expect(run.reason).toMatch(interruption === 'cancel' ? /cancel/i : /deadline/i);
    expect(run.trace).toEqual([]);
    expect(run.actors.find(actor => actor.actor === 'alice')?.status).toBe('rejected');
    expect(run.actors.find(actor => actor.actor === 'bob')?.status).toBe('fulfilled');
    expect(run.cleanup.complete).toBe(true);
    expect(parseRunArtifact(run)).toEqual(run);
  } finally {
    controller.abort();
    try { await running; } finally { try { await admin.end(); } finally { observer.mockRestore(); } }
  }
});
