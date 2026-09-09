import assert from 'node:assert/strict';
import net from 'node:net';
import { Client } from 'pg';
import postgres from 'postgres';
import { afterEach, describe, expect, test } from 'vitest';
import { createOwnedDatabase } from '../src/database.js';
import { createProxy } from '../src/proxy.js';
import { FrameDecoder } from '../src/protocol/framing.js';
import type { PendingUnit, ProxyEvent, ProxyOptions, UnitCompletion } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

async function until<T>(predicate: () => T | false | undefined): Promise<T> {
  const end = Date.now() + 3000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for staged protocol evidence');
}
async function untilAsync<T>(predicate: () => Promise<T | false | undefined>): Promise<T> {
  const end = Date.now() + 3000;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for a real PostgreSQL wait');
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
/** Transport-only observation: retain an actual RowDescription, never synthesize it. */
async function wireRelay(connectionString: string, holdRow = false) {
  const url = new URL(connectionString), sockets = new Set<net.Socket>(); const targetPort = Number(url.port); const frontendTypes: string[] = [];
  let held: { client: net.Socket; frame: Buffer } | undefined;
  const server = net.createServer(client => {
    const remote = net.connect({ host: url.hostname, port: targetPort });
    for (const socket of [client, remote]) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
    const frontend = new FrameDecoder('startup'), backend = new FrameDecoder('typed'); let started = false;
    client.on('data', chunk => { for (const frame of frontend.push(chunk)) { if (started) frontendTypes.push(String.fromCharCode(frame[0]!)); else started = true; remote.write(frame); } });
    remote.on('data', chunk => { for (const frame of backend.push(chunk)) {
      if (holdRow && frame[0] === 84) { holdRow = false; held = { client, frame }; }
      else client.write(frame);
    } });
    client.on('end', () => remote.end()); remote.on('end', () => client.end());
    client.on('close', () => remote.destroy()); remote.on('close', () => client.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); url.port = String(address.port);
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { connectionString: url.toString(), frontendTypes, releaseRow() { assert.ok(held); held.client.write(held.frame); held = undefined; } };
}
async function harness(auto = false, driver: { prepare?: boolean; fetch_types?: boolean } = {}, extra: Partial<ProxyOptions> = {}, delayedMetadata = false) {
  const owned = await createOwnedDatabase(testDatabaseUrl()); cleanups.push(() => owned.close());
  await owned.db.query('CREATE TABLE effects (id integer PRIMARY KEY, value integer)');
  const units: PendingUnit[] = [], completions: UnitCompletion[] = [], errors: Error[] = [], events: ProxyEvent[] = [];
  const egress = delayedMetadata ? await wireRelay(owned.connectionString, true) : undefined;
  const proxy = await createProxy({ actor: 'installer', upstreamUrl: egress?.connectionString ?? owned.connectionString, protocolProfile: 'describe-flush-v1',
    onUnit(unit) { units.push(unit); if (auto) void unit.release().then(value => completions.push(value), error => errors.push(error)); }, onError(error) { errors.push(error); }, onEvent(event) { events.push(event); }, ...extra });
  const ingress = delayedMetadata ? await wireRelay(proxy.connectionString) : undefined;
  const sql = postgres(ingress?.connectionString ?? proxy.connectionString, { max: 1, ssl: false, connect_timeout: 3, fetch_types: false, ...driver });
  cleanups.push(async () => { await proxy.close(); await sql.end({ timeout: 1 }); });
  return { owned, proxy, sql, units, completions, errors, events, ingress, egress };
}

describe('Postgres.js staged metadata protocol against real PostgreSQL', () => {
  test('gates real metadata and the entire parameterized INSERT independently', async () => {
    const h = await harness(); const query = Promise.resolve(h.sql`INSERT INTO effects VALUES (${7}, ${31}) RETURNING value`); void query.catch(() => {});
    const first = await until(() => h.units[0]); expect(first).toMatchObject({ stage: 'describe', cycle: 0, ordinal: 0 });
    expect((await h.owned.db.query('SELECT * FROM effects')).rows).toEqual([]);
    expect(await first.release()).toEqual({ kind: 'metadata', result: 'described', parameterCount: 2, columnCount: 1, resultShape: 'rows' });
    const second = await until(() => h.units[1]); expect(second).toMatchObject({ stage: 'execute', cycle: 0, ordinal: 1, prefixOrdinal: 0 });
    expect((await h.owned.db.query('SELECT * FROM effects')).rows).toEqual([]);
    expect(await second.release()).toMatchObject({ kind: 'ready', transactionStatus: 'I', commandTags: ['INSERT 0 1'], rowCount: 1 });
    expect([...(await query)]).toEqual([{ value: 31 }]); await expect(second.release()).rejects.toThrow(/already released/);
    expect(h.errors).toEqual([]);
  });
  test.each([true, false])('preserves default type discovery, parameters, prepared reuse, transaction error and rollback (prepare %s)', async prepare => {
    const h = await harness(true, { prepare, fetch_types: true });
    const select = (value: string | null) => h.sql`SELECT ${value}::text AS value`;
    expect((await select('first'))[0]?.value).toBe('first'); expect((await select(null))[0]?.value).toBeNull();
    const selectUnits = h.units.filter(unit => unit.sql === 'SELECT $1::text AS value');
    expect(selectUnits.map(unit => unit.stage)).toEqual(prepare ? ['describe', 'execute', 'complete'] : ['describe', 'execute', 'describe', 'execute']);
    const binary = Buffer.from([0, 255, 128]);
    expect((await h.sql`SELECT ${binary}::bytea AS value`)[0]?.value).toEqual(binary);
    await h.sql.begin(async sql => { await sql`INSERT INTO effects VALUES (${1}, ${41})`; });
    await expect(h.sql.begin(async sql => { await sql`INSERT INTO effects VALUES (${1}, ${42})`; })).rejects.toMatchObject({ code: '23505' });
    expect([...(await h.sql`SELECT value FROM effects`)]).toEqual([{ value: 41 }]);
    expect(h.units[0]!.sql).toContain('pg_catalog.pg_type'); expect(h.units[0]).toMatchObject({ stage: 'complete', cycle: 0 });
    expect(h.completions.some(c => c.kind === 'metadata' && c.result === 'described')).toBe(true);
    expect(h.errors).toEqual([]);
  });
  test.each([false, true])('retains Parse error through the actual Sync recovery (transaction %s)', async inTransaction => {
    const h = await harness(true);
    const bad = inTransaction ? h.sql.begin(async sql => { await sql`INSER INTO effects VALUES (${1}, ${2})`; }) : h.sql`INSER INTO effects VALUES (${1}, ${2})`;
    await expect(bad).rejects.toMatchObject({ code: '42601' });
    expect((await h.sql`SELECT 9 AS n`)[0]?.n).toBe(9);
    const index = h.units.findIndex(unit => unit.stage === 'recover'); expect(index).toBeGreaterThan(-1);
    expect(h.completions[index]).toMatchObject({ kind: 'ready', transactionStatus: inTransaction ? 'E' : 'I', error: { code: '42601' } });
    expect(h.errors).toEqual([]);
  });
  test('closing after metadata rejects the unreleased continuation and leaves no INSERT or backend', async () => {
    const h = await harness(); const result = Promise.resolve(h.sql`INSERT INTO effects VALUES (${7}, ${31})`).catch(error => error);
    const first = await until(() => h.units[0]); await first.release(); const second = await until(() => h.units[1]);
    await h.proxy.close(); assert.ok(await result instanceof Error);
    await expect(second.release()).rejects.toThrow(/closed/);
    expect((await h.owned.db.query('SELECT * FROM effects')).rows).toEqual([]);
    expect((await h.owned.db.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [first.backendPid])).rows).toEqual([]);
  });
  test.each([null, 'invalid'])('rejects invalid protocol profile %s before opening a listener', async profile => {
    await expect(createProxy({ upstreamUrl: testDatabaseUrl(), actor: 'x', onUnit() {}, onError() {}, protocolProfile: profile as never }).then(proxy => { cleanups.push(() => proxy.close()); return proxy; })).rejects.toThrow(/protocolProfile/);
  });
  test('buffers continuation sent after ParameterDescription until the actual RowDescription arrives', async () => {
    const h = await harness(false, {}, {}, true);
    const query = Promise.resolve(h.sql`INSERT INTO effects VALUES (${7}, ${31}) RETURNING value`); void query.catch(() => {});
    const first = await until(() => h.units[0]); let metadataComplete = false;
    const pending = first.release().then(value => { metadataComplete = true; return value; });
    await until(() => h.ingress!.frontendTypes.includes('S'));
    expect(h.ingress!.frontendTypes.slice(-3)).toEqual(['B', 'E', 'S']);
    expect(h.units).toHaveLength(1); expect(metadataComplete).toBe(false);
    expect(h.egress!.frontendTypes.includes('B')).toBe(false);
    h.egress!.releaseRow(); expect(await pending).toMatchObject({ kind: 'metadata', result: 'described' });
    const second = await until(() => h.units[1]); await second.release(); expect([...(await query)]).toEqual([{ value: 31 }]); expect(h.errors).toEqual([]);
  });
  test('observes a real relation lock during the released prefix and keeps its PID through execution', async () => {
    const h = await harness(); await h.owned.db.query('INSERT INTO effects VALUES (1, 41)');
    const observer = new Client({ connectionString: h.owned.connectionString }); await observer.connect(); cleanups.push(() => observer.end());
    await h.owned.db.query('BEGIN'); await h.owned.db.query('LOCK TABLE effects IN ACCESS EXCLUSIVE MODE');
    const query = Promise.resolve(h.sql`SELECT value FROM effects WHERE id=${1}`); void query.catch(() => {});
    const first = await until(() => h.units[0]); const metadata = first.release();
    const wait = await untilAsync(async () => { const row = (await observer.query('SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1', [first.backendPid])).rows[0]; return row?.wait_event_type === 'Lock' ? row : false; });
    expect(wait.blockers.length).toBe(1); expect(h.units).toHaveLength(1);
    await h.owned.db.query('ROLLBACK'); await metadata;
    const second = await until(() => h.units[1]); expect(second.backendPid).toBe(first.backendPid); await second.release();
    expect([...(await query)]).toEqual([{ value: 41 }]); expect(h.errors).toEqual([]);
  });
  test('retains the prefix table lock until the original execution Sync completes', async () => {
    const h = await harness(); const query = Promise.resolve(h.sql`SELECT value FROM effects WHERE id=${1}`); void query.catch(() => {});
    const first = await until(() => h.units[0]); await first.release(); const second = await until(() => h.units[1]);
    const blocker = new Client({ connectionString: h.owned.connectionString }); await blocker.connect(); cleanups.push(() => blocker.end());
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const ddl = blocker.query('ALTER TABLE effects ADD COLUMN other integer'); void ddl.catch(() => {});
    await untilAsync(async () => { const row = (await h.owned.db.query('SELECT pg_blocking_pids($1) AS blockers', [pid])).rows[0]; return row.blockers.includes(first.backendPid) ? row : false; });
    await second.release(); await query; await ddl; expect(h.errors).toEqual([]);
  });
  test('closing while Parse is blocked rejects its gate and removes the owned backend', async () => {
    const h = await harness();
    const observer = new Client({ connectionString: h.owned.connectionString }); await observer.connect(); cleanups.push(() => observer.end());
    await h.owned.db.query('BEGIN'); await h.owned.db.query('LOCK TABLE effects IN ACCESS EXCLUSIVE MODE');
    const query = Promise.resolve(h.sql`INSERT INTO effects VALUES (${1}, ${41})`).catch(error => error);
    const first = await until(() => h.units[0]); const metadata = first.release().catch(error => error);
    await untilAsync(async () => { const row = (await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [first.backendPid])).rows[0]; return row?.wait_event_type === 'Lock'; });
    await h.proxy.close(); expect(await metadata).toBeInstanceOf(Error); expect(await query).toBeInstanceOf(Error);
    await h.owned.db.query('ROLLBACK');
    await untilAsync(async () => (await observer.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [first.backendPid])).rows.length === 0);
    expect((await h.owned.db.query('SELECT * FROM effects')).rows).toEqual([]); expect(h.units).toHaveLength(1);
  });
  test('preserves actual public pipelining of cached and new parameterized statements', async () => {
    const h = await harness(true); const select = (id: number) => h.sql`SELECT ${id}::integer AS id`;
    await select(0);
    const rows = await Promise.all([select(1), select(2), h.sql`SELECT ${'new'}::text AS label`, select(3)]);
    expect(rows.map(result => [...result])).toEqual([[{ id: 1 }], [{ id: 2 }], [{ label: 'new' }], [{ id: 3 }]]);
    expect(h.errors).toEqual([]);
  });
});
