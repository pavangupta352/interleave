import assert from 'node:assert/strict';
import type { EventEmitter } from 'node:events';
import { Client, Pool } from 'pg';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Kysely, PostgresDialect } from 'kysely';
import { forPg, forPostgresJs, forDrizzle, forKysely, type SearchResult } from './vendor/pghybrid/dist/index.js';
import { CONFIG, EMBEDDING, EXPECTED_TITLES, QUERY, createPghybridScenario } from './scenario.js';
import type { ActorContext, RunOptions, Scenario } from '../../src/types.js';

export type PghybridAdapter = 'pg-pool' | 'pg-client' | 'postgresjs' | 'drizzle' | 'kysely';
export type PghybridBehavior = 'reuse' | 'reconnect' | 'handled-error' | 'unhandled-error';
const adapters: PghybridAdapter[] = ['pg-pool', 'pg-client', 'postgresjs', 'drizzle', 'kysely'];
const applicationName = 'pghybrid-adapter-qualification';

export function pghybridAdapterOptions(adapter: PghybridAdapter): Pick<RunOptions, 'fixtureProfile' | 'protocolProfile'> {
  if (!adapters.includes(adapter)) throw new TypeError('Unknown pghybrid adapter');
  return { fixtureProfile: 'postgresql17-pgvector0.8.6-v1',
    protocolProfile: adapter === 'postgresjs' ? 'describe-flush-v1' : 'sync-cycle-v1' };
}

type Search = (table?: string) => Promise<SearchResult[]>;

/** Own checked-out client errors and public retirement for a caller-owned Pool. */
export function observePoolClients(pool: Pool, onError: (error: Error) => void): {
  interrupt(): void; waitForEnd(): Promise<void>;
} {
  const retiring = new Map<Client, Promise<void>>();
  const stopping = new WeakSet<Client>();
  let interrupted = false;
  const stop = (client: Client): void => {
    if (stopping.has(client)) return;
    stopping.add(client);
    void client.end().catch(onError);
  };
  pool.on('connect', client => {
    // Pool.error covers idle clients. A checked-out client also needs its own
    // listener, including the interval before an ORM submits its first query.
    client.on('error', onError);
    const ended = new Promise<void>(resolve => client.once('end', () => {
      retiring.delete(client); client.off('error', onError); resolve();
    }));
    retiring.set(client, ended);
    if (interrupted) stop(client);
  });
  return {
    interrupt() { interrupted = true; for (const client of retiring.keys()) stop(client); },
    waitForEnd: () => Promise.all([...retiring.values()]).then(() => {}),
  };
}

/** The library owns no connection; this example owns and closes its real caller. */
async function usingCaller<T>(adapter: PghybridAdapter, { connectionString, signal }: ActorContext, action: (search: Search) => Promise<T>): Promise<T> {
  let search: Search;
  let connect = async (): Promise<void> => {};
  let closeDriver: (aborted: boolean) => Promise<void>;
  let interruptPool: (() => void) | undefined;
  let clientError: Error | undefined;
  let pg: EventEmitter | undefined;
  if (adapter === 'postgresjs') {
    const sql = postgres(connectionString, { max: 1, ssl: false, connection: { application_name: applicationName } });
    search = table => forPostgresJs(sql, { ...CONFIG, table: table ?? CONFIG.table }).search(QUERY, { embedding: EMBEDDING, limit: 3 });
    closeDriver = aborted => sql.end({ timeout: aborted ? 0 : 1 });
  } else if (adapter === 'pg-client') {
    const client = new Client({ connectionString, application_name: applicationName, connectionTimeoutMillis: 5000 });
    pg = client; connect = async () => { await client.connect(); };
    search = table => forPg(client, { ...CONFIG, table: table ?? CONFIG.table }).search(QUERY, { embedding: EMBEDDING, limit: 3 });
    closeDriver = () => client.end();
  } else {
    const pool = new Pool({ connectionString, max: 1, application_name: applicationName, connectionTimeoutMillis: 5000 });
    pg = pool;
    // Pool.end()/query rejection may precede the retired client's end event.
    // Observe the public lifecycle before opening a replacement on this actor URL.
    const lifecycle = observePoolClients(pool, error => { clientError ??= error; abort(); });
    const endedClients = lifecycle.waitForEnd;
    interruptPool = lifecycle.interrupt;
    closeDriver = async () => { await pool.end(); await endedClients(); };
    if (adapter === 'drizzle') {
      const db = drizzle(pool);
      search = table => forDrizzle(db, { ...CONFIG, table: table ?? CONFIG.table }).search(QUERY, { embedding: EMBEDDING, limit: 3 });
    } else if (adapter === 'kysely') {
      const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
      search = table => forKysely(db, { ...CONFIG, table: table ?? CONFIG.table }).search(QUERY, { embedding: EMBEDDING, limit: 3 });
      closeDriver = async () => { await db.destroy(); await endedClients(); };
    } else search = table => forPg(pool, { ...CONFIG, table: table ?? CONFIG.table }).search(QUERY, { embedding: EMBEDDING, limit: 3 });
    if (adapter === 'pg-pool' || adapter === 'drizzle') {
      const query = search;
      search = async table => {
        try { return await query(table); }
        catch (error) { await endedClients(); throw error; }
      };
    }
  }
  let ending: Promise<void> | undefined;
  const close = (aborted = false): Promise<void> => ending ??= closeDriver(aborted);
  const abort = (): void => {
    // End checked-out clients promptly, but let acquisition/query release unwind
    // before destroying the ORM. Kysely still needs its Pool during acquisition.
    if (interruptPool) interruptPool();
    else void close(true).catch(() => {});
  };
  pg?.on('error', abort);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await connect();
    const result = await action(search);
    if (clientError) throw clientError;
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    try { await close(); } finally { pg?.off('error', abort); }
  }
}

function titles(rows: SearchResult[]): string[] {
  for (const row of rows) {
    assert.ok(Number.isFinite(row.score) && row.score > 0);
    assert.ok(Number.isFinite(row.fusedScore) && row.fusedScore > 0);
    for (const rank of [row.textRank, row.vectorRank]) assert.ok(rank === null || (Number.isInteger(rank) && rank > 0));
    assert.ok(['both', 'vector', 'text', 'none'].includes(row.matchedBy));
  }
  const result = rows.map(row => String(row.row.title));
  assert.deepEqual(result, EXPECTED_TITLES);
  return result;
}

/** Constructed compatibility/lifecycle workload; vendor code and fixture values are unchanged. */
export function createPghybridAdapterScenario(adapter: PghybridAdapter, behavior: PghybridBehavior = 'reuse'): Scenario {
  pghybridAdapterOptions(adapter);
  if (!['reuse', 'reconnect', 'handled-error', 'unhandled-error'].includes(behavior)) throw new TypeError('Unknown pghybrid behavior');
  const actor = async (context: ActorContext) => {
    const observations = await usingCaller(adapter, context, async search => {
      if (behavior === 'unhandled-error') return [titles(await search('missing_adapter_fixture'))];
      if (behavior === 'handled-error') {
        await assert.rejects(search('missing_adapter_fixture'), { code: '42P01' });
      }
      return [titles(await search()), titles(await search())];
    });
    if (behavior === 'reconnect') observations.push(await usingCaller(adapter, context, async search => titles(await search())));
    return observations;
  };
  return {
    ...createPghybridScenario(), name: `pghybrid-0.1.4-${adapter}-${behavior}`,
    actors: { first: actor, second: actor },
    async invariant({ results }) {
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.status, 'fulfilled');
        assert.deepEqual(result.value, Array.from({ length: behavior === 'reconnect' ? 3 : 2 }, () => EXPECTED_TITLES));
      }
    },
  };
}
