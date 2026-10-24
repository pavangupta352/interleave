import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import postgres from 'postgres';
import { afterEach, describe, expect, test } from 'vitest';
import { Client, Query } from 'pg';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import type { ActorContext, RunResult, Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const ownedNames = new Set<string>();
afterEach(async () => {
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  try {
    const leftovers = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [[...ownedNames]])).rows;
    for (const { datname } of leftovers) { assert.match(datname, /^interleave_[0-9a-f]{32}$/); await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`); }
    expect(leftovers).toEqual([]);
  } finally { ownedNames.clear(); await admin.end(); }
});

function checked(run: RunResult, outcome: RunResult['outcome'] = 'passed'): RunResult {
  expect(run.outcome, run.reason).toBe(outcome); expect(run.cleanup.complete).toBe(true);
  expect(parseRunArtifact(run)).toEqual(run); return run;
}
function scenario(name: string, actors: Scenario['actors'], invariant: Scenario['invariant'] = async () => {}): Scenario {
  return { name, async setup({ connectionString }) { ownedNames.add(new URL(connectionString).pathname.slice(1)); }, actors, invariant };
}
async function withPostgres<T>({ connectionString, signal }: ActorContext, body: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(connectionString, { max: 1, ssl: false, fetch_types: false });
  const abort = () => { void sql.end({ timeout: 0 }); };
  signal.addEventListener('abort', abort, { once: true });
  try { return await body(sql); }
  finally { signal.removeEventListener('abort', abort); await sql.end({ timeout: 1 }); }
}
async function withClient<T>({ connectionString, signal }: ActorContext, body: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString }); client.on('error', () => {});
  const abort = () => { void client.end().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  await client.connect();
  try { return await body(client); }
  finally { signal.removeEventListener('abort', abort); await client.end().catch(() => {}); }
}
const errorCode = (error: unknown): string => String((error as { code?: unknown }).code);
/** node-postgres sends a cancel request from a new client with the same settings. */
function cancelQuery(connectionString: string, client: Client, query: Query): void {
  (new Client({ connectionString }) as unknown as { cancel(client: Client, query: Query): void }).cancel(client, query);
}
function settle(query: Query): Promise<string> {
  return new Promise(resolve => { query.once('error', error => resolve(errorCode(error))); query.once('end', () => resolve('completed')); });
}
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** What libpq's PQcancel sends, optionally after asking for encryption first. */
async function rawCancel(connectionString: string, pid: number, secret: number, encryptionRequest = false): Promise<void> {
  const url = new URL(connectionString);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  socket.on('error', () => {});
  await once(socket, 'connect');
  if (encryptionRequest) {
    const request = Buffer.alloc(8); request.writeInt32BE(8); request.writeInt32BE(80877103, 4);
    socket.write(request);
    const [answer] = await once(socket, 'data') as [Buffer];
    expect(answer.toString('latin1')).toBe('N');
  }
  const packet = Buffer.alloc(16);
  packet.writeInt32BE(16); packet.writeInt32BE(80877102, 4); packet.writeInt32BE(pid, 8); packet.writeInt32BE(secret, 12);
  socket.write(packet); socket.resume();
  await once(socket, 'close');
}

describe('cancel requests through actual drivers and real PostgreSQL', () => {
  test.each([1, 2])('Postgres.js query.cancel() stops the running statement with 57014 and replays (connection cap %i)', async cap => {
    const run = scenario('cancel a sleeping statement', {
      alice: context => withPostgres(context, async sql => {
        const query = sql`SELECT pg_sleep(30)`;
        const timer = setTimeout(() => { void query.cancel(); }, 300);
        try { await query; return 'completed'; } catch (error) { return errorCode(error); } finally { clearTimeout(timer); }
      }),
      async bob() {},
    }, async ({ results }) => { assert.equal(results.find(result => result.actor === 'alice')?.value, '57014'); });
    const options = { databaseUrl, protocolProfile: 'describe-flush-v1' as const, maxConnectionsPerActor: cap };
    const first = checked(await runOnce(run, options));
    expect(first.schemaVersion).toBe(5);
    expect(first.limits.connectionProfile).toBe('single-producer-v1');
    // Postgres.js describes the statement first; the cancel hits the step that runs it.
    const sleeping = first.trace.findIndex(step => step.stage !== 'describe' && step.sql === 'SELECT pg_sleep(30)');
    expect(sleeping).toBeGreaterThanOrEqual(0);
    expect(first.cancels).toEqual([{ at: expect.any(Number), actor: 'alice', backendPid: first.trace[sleeping]!.backendPid, forwarded: true, connection: 0, step: sleeping }]);
    expect(first.trace[sleeping]!.completion?.error?.code).toBe('57014');
    // The secret key is never recorded.
    expect(JSON.stringify(first)).not.toMatch(/secret/i);
    const repeated = checked(await replay(run, first, { databaseUrl }));
    expect(repeated.cancels?.map(({ at: _at, backendPid: _pid, ...rest }) => rest)).toEqual([{ actor: 'alice', forwarded: true, connection: 0, step: sleeping }]);
  }, 60_000);

  test('a cancel request for a command the scheduler still holds finds an idle backend, and the command then runs', async () => {
    const run = scenario('cancel a held command', {
      alice: context => withClient(context, async client => {
        const query = client.query(new Query('SELECT pg_sleep(0.2)'));
        const settled = settle(query);
        await delay(300);
        cancelQuery(context.connectionString, client, query);
        return settled;
      }),
      bob: context => withClient(context, async client => { await client.query('SELECT pg_sleep(1)'); }),
    }, async ({ results }) => { assert.equal(results.find(result => result.actor === 'alice')?.value, 'completed'); });
    const first = checked(await runOnce(run, { databaseUrl, plan: ['bob', 'alice'] }));
    expect(first.schemaVersion).toBe(5);
    expect(first.trace.map(step => step.actor)).toEqual(['bob', 'alice']);
    expect(first.cancels).toEqual([{ at: expect.any(Number), actor: 'alice', backendPid: first.trace[1]!.backendPid, forwarded: true, connection: 0 }]);
    expect(first.cancels![0]!.at).toBeLessThan(first.trace[1]!.releasedAt);
    expect(first.trace[1]!.completion?.error).toBeUndefined();
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);

  test('a request names its own connection in the multi-producer profile and replays through the connection binding', async () => {
    const run = scenario('cancel one connection', {
      alice: async ({ connectionString, signal }) => {
        const sleeper = new Client({ connectionString }); const other = new Client({ connectionString });
        const clients = [sleeper, other]; for (const client of clients) client.on('error', () => {});
        const abort = () => { for (const client of clients) void client.end().catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          await sleeper.connect(); await other.connect();
          const query = sleeper.query(new Query('SELECT pg_sleep(30)'));
          const settled = settle(query);
          const timer = setTimeout(() => cancelQuery(connectionString, sleeper, query), 300);
          try { const [code] = await Promise.all([settled, other.query('SELECT 1')]); return code; } finally { clearTimeout(timer); }
        } finally { signal.removeEventListener('abort', abort); await Promise.all(clients.map(client => client.end().catch(() => {}))); }
      },
      async bob() {},
    }, async ({ results }) => { assert.equal(results.find(result => result.actor === 'alice')?.value, '57014'); });
    const first = checked(await runOnce(run, { databaseUrl, connectionProfile: 'multi-producer-v1' }));
    expect(first.schemaVersion).toBe(5);
    expect(first.limits.connectionProfile).toBe('multi-producer-v1');
    const sleeping = first.trace.findIndex(step => step.sql === 'SELECT pg_sleep(30)');
    expect(first.cancels).toEqual([{ at: expect.any(Number), actor: 'alice', backendPid: first.trace[sleeping]!.backendPid, forwarded: true, connection: first.trace[sleeping]!.connection, step: sleeping }]);
    expect(first.trace[sleeping]!.completion?.error?.code).toBe('57014');
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);

  test('a request for an unknown backend is recorded and never forwarded, including after an encryption request', async () => {
    const run = scenario('cancel an unknown backend', {
      alice: context => withClient(context, async client => {
        await rawCancel(context.connectionString, 1, 0);
        await rawCancel(context.connectionString, 1, 0, true);
        return (await client.query('SELECT 1 AS one')).rows[0].one;
      }),
      bob: context => withClient(context, async client => { await client.query('SELECT 1'); }),
    });
    const first = checked(await runOnce(run, { databaseUrl }));
    expect(first.schemaVersion).toBe(5);
    expect(first.cancels).toEqual([
      { at: expect.any(Number), actor: 'alice', backendPid: 1, forwarded: false },
      { at: expect.any(Number), actor: 'alice', backendPid: 1, forwarded: false },
    ]);
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);

  test('a request for another actor\'s backend stops the run as inconclusive without reaching PostgreSQL', async () => {
    let key: { pid: number; secret: number } | undefined;
    const run = scenario('cancel across actors', {
      alice: async context => {
        while (!key) await delay(5);
        await rawCancel(context.connectionString, key.pid, key.secret);
      },
      bob: context => withClient(context, async client => {
        const internals = client as unknown as { processID: number; secretKey: number };
        key = { pid: internals.processID, secret: internals.secretKey };
        return client.query('SELECT pg_sleep(0.5)').then(() => 'completed', errorCode);
      }),
    });
    const first = checked(await runOnce(run, { databaseUrl }), 'inconclusive');
    expect(first.reason).toContain('alice sent a cancel request for a connection of bob');
    expect(first.cancels).toEqual([{ at: expect.any(Number), actor: 'alice', backendPid: key!.pid, forwarded: false }]);
  }, 60_000);

  test('replay is incompatible when a cancel request hits a different step than recorded', async () => {
    const run = scenario('cancel a sleeping statement', {
      alice: context => withPostgres(context, async sql => {
        const query = sql`SELECT pg_sleep(30)`;
        const timer = setTimeout(() => { void query.cancel(); }, 300);
        try { await query; return 'completed'; } catch (error) { return errorCode(error); } finally { clearTimeout(timer); }
      }),
      async bob() {},
    });
    const first = checked(await runOnce(run, { databaseUrl, protocolProfile: 'describe-flush-v1' }));
    const altered = structuredClone(first);
    delete altered.cancels![0]!.step;
    const repeated = checked(await replay(run, parseRunArtifact(altered), { databaseUrl }), 'incompatible');
    expect(repeated.reason).toMatch(/^Replay cancel request 0 from alice hit step \d+; the recorded request from alice found its backend idle; the application's own timers/);
  }, 60_000);
});
