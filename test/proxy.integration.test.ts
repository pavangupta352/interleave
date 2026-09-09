import { testDatabaseUrl } from './helpers/postgres.js';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createProxy } from '../src/proxy.js';
import { FrameDecoder } from '../src/protocol/framing.js';
import type { ActorProxy, PendingUnit, ProxyEvent, UnitCompletion } from '../src/types.js';

const adminUrl = testDatabaseUrl();
const integration = describe;
const databaseName = 'interleave_' + randomBytes(12).toString('hex');
let databaseUrl: string; let admin: Client; let direct: Client;
const resources: { proxy: ActorProxy; clients: Client[] }[] = [];
async function until<T>(predicate: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Timed out waiting for test evidence');
}
async function harness(auto = false) {
  const units: PendingUnit[] = []; const errors: Error[] = []; const events: ProxyEvent[] = []; const completions: UnitCompletion[] = [];
  const proxy = await createProxy({ upstreamUrl: databaseUrl, actor: 'test', onUnit(unit) { units.push(unit); if (auto) void unit.release().then(c => completions.push(c), e => errors.push(e)); }, onError(error) { errors.push(error); }, onEvent(event) { events.push(event); } });
  const client = new Client({ connectionString: proxy.connectionString }); client.on('error', () => {});
  resources.push({ proxy, clients: [client] }); await client.connect();
  return { proxy, client, units, errors, events, completions };
}
function packet(type: string, payload = Buffer.alloc(0)) { const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeInt32BE(payload.length + 4, 1); return Buffer.concat([header, payload]); }
function errorPacket(code: string, message: string): Buffer {
  return packet('E', Buffer.from(`SERROR\0VERROR\0C${code}\0M${message}\0\0`));
}
async function delayedErrorBackend(options: { messageBytes?: number } = {}): Promise<{
  url: string;
  finishQuery(result?: 'ready' | 'close'): void;
  close(): Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  let querySocket: net.Socket | undefined;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    const frames = new FrameDecoder('startup');
    let startup = true;
    socket.on('data', chunk => {
      for (const frame of frames.push(chunk)) {
        if (startup) {
          startup = false;
          const auth = Buffer.alloc(4); auth.writeUInt32BE(0);
          const key = Buffer.alloc(8); key.writeInt32BE(4242, 0); key.writeInt32BE(31337, 4);
          socket.write(Buffer.concat([packet('R', auth), packet('K', key), packet('Z', Buffer.from('I'))]));
        } else if (String.fromCharCode(frame[0]!) === 'Q') {
          querySocket = socket;
          socket.write(errorPacket('42P01', 'x'.repeat(options.messageBytes ?? 'missing relation'.length)));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake PostgreSQL backend did not bind');
  return {
    url: `postgresql://actor@127.0.0.1:${address.port}/fixture`,
    finishQuery(result = 'ready') {
      if (!querySocket) throw new Error('Fake PostgreSQL backend has not received a query');
      if (result === 'close') querySocket.end();
      else querySocket.write(packet('Z', Buffer.from('I')));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
async function rawSocket(url: string) {
  const address = new URL(url); const socket = net.connect({ host: address.hostname, port: Number(address.port) });
  socket.on('error', () => {}); await new Promise<void>(resolve => socket.once('connect', resolve)); return socket;
}
function duplicateDatabaseStream(database: string): net.Socket {
  const stream = new net.Socket();
  stream.once('connect', () => {
    const write = stream.write.bind(stream); let startup = true;
    stream.write = ((chunk: Buffer, ...args: unknown[]) => {
      if (startup && Buffer.isBuffer(chunk) && chunk.length >= 9 && chunk.readUInt32BE(4) === 196608) {
        startup = false;
        const extra = Buffer.from(`database\0${database}\0`);
        const duplicate = Buffer.concat([chunk.subarray(0, 8), extra, chunk.subarray(8)]);
        duplicate.writeUInt32BE(duplicate.length, 0);
        return (write as (...values: unknown[]) => boolean)(duplicate, ...args);
      }
      return (write as (...values: unknown[]) => boolean)(chunk, ...args);
    }) as typeof stream.write;
  });
  return stream;
}

interface RawConnection extends EventEmitter {
  parse(query: { name: string; text: string; types: number[] }): void;
  bind(query: { portal: string; statement: string; values: unknown[] }): void;
  describe(query: { type: string; name: string }): void;
  execute(query: { portal: string; rows: number }): void;
  close(query: { type: string; name: string }): void;
  sync(): void;
}
function rawDriver(client: Client) {
  const connection = (client as unknown as { connection: RawConnection }).connection;
  for (const event of ['readyForQuery', 'parseComplete', 'bindComplete', 'closeComplete', 'rowDescription', 'dataRow', 'commandComplete', 'errorMessage']) connection.removeAllListeners(event);
  const rows: string[][] = []; const codes: string[] = [];
  connection.on('dataRow', (row: { fields: Buffer[] }) => rows.push(row.fields.map(field => field.toString())));
  connection.on('errorMessage', (error: { code: string }) => codes.push(error.code));
  return { connection, rows, codes, cycle(work: () => void) {
    const done = new Promise<void>(resolve => connection.once('readyForQuery', resolve));
    work(); connection.sync(); return done;
  }, execute(name: string) {
    connection.bind({ portal: '', statement: name, values: [] });
    connection.describe({ type: 'P', name: '' }); connection.execute({ portal: '', rows: 0 });
  } };
}

integration('proxy integration with real PostgreSQL', () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl! }); await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminUrl!); url.pathname = '/' + databaseName; databaseUrl = url.toString();
    direct = new Client({ connectionString: databaseUrl }); await direct.connect();
    await direct.query('CREATE TABLE gate (id integer PRIMARY KEY, payload bytea)');
  });
  afterAll(async () => {
    for (const resource of resources) { await resource.proxy.close(); await Promise.all(resource.clients.map(c => c.end().catch(() => {}))); }
    await direct?.end();
    if (admin) { await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName]); await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await admin.end(); }
  });
  test('holds original simple query until release, captures backend PID, and releases exactly once', async () => {
    const h = await harness(); const result = h.client.query('INSERT INTO gate(id) VALUES (1) RETURNING id');
    const unit = await until(() => h.units[0]);
    expect(unit).toMatchObject({ actor: 'test', connection: 0, ordinal: 0, protocol: 'simple' });
    expect(unit.backendPid).toBeGreaterThan(0);
    expect((await direct.query('SELECT * FROM gate WHERE id=1')).rows).toEqual([]);
    expect((await direct.query('SELECT state FROM pg_stat_activity WHERE pid=$1', [unit.backendPid])).rows[0].state).toBe('idle');
    expect(await unit.release()).toMatchObject({ transactionStatus: 'I', commandTags: ['INSERT 0 1'], rowCount: 1 });
    expect((await result).rows).toEqual([{ id: 1 }]); await expect(unit.release()).rejects.toThrow(/already released/i);
    expect(h.errors).toEqual([]); await h.client.end();
  });
  test('preserves parameterized binary/null values and reused named statement semantics', async () => {
    const h = await harness(true); const query = { name: 'named_binary', text: 'SELECT $1::bytea AS binary, $2::text AS nullable, $3::int AS number', values: [Buffer.from([0, 255, 1, 128]), null, 37] };
    const expected = await direct.query(query);
    expect((await h.client.query(query)).rows).toEqual(expected.rows); expect((await h.client.query(query)).rows).toEqual(expected.rows);
    expect(h.units).toHaveLength(2); expect(h.units[0]!.protocol).toBe('extended');
    expect(h.units[0]!.fingerprint).toBe(h.units[1]!.fingerprint); expect(h.errors).toEqual([]); await h.client.end();
  });
  test('failed named Parse preserves the acknowledged statement identity and actual recovery result', async () => {
    const h = await harness(true); const raw = rawDriver(h.client);
    await raw.cycle(() => raw.connection.parse({ name: 's', text: 'SELECT 111 AS n', types: [] }));
    await raw.cycle(() => raw.connection.parse({ name: 's', text: 'SELECT 999 AS n', types: [] }));
    await raw.cycle(() => raw.execute('s'));
    expect(raw.codes).toEqual(['42P05']); expect(raw.rows).toEqual([['111']]);
    expect(h.units[2]!.sql).toBe('SELECT 111 AS n');
    const recoveryFingerprint = h.units[2]!.fingerprint;
    await raw.cycle(() => raw.execute('s'));
    expect(h.units[3]!.fingerprint).toBe(recoveryFingerprint); expect(h.errors).toEqual([]);
    await h.client.end();
  });
  test('publishes queued identity only after acknowledgement and ignores Parse or Close skipped after an error', async () => {
    const h = await harness(); const raw = rawDriver(h.client);
    const setup = raw.cycle(() => raw.connection.parse({ name: 's', text: 'SELECT 111 AS n', types: [] }));
    await (await until(() => h.units[0])).release(); await setup;
    const failed = raw.cycle(() => {
      raw.connection.parse({ name: 'accepted', text: 'SELECT 222 AS n', types: [] });
      raw.connection.parse({ name: 's', text: 'SELECT 999 AS n', types: [] });
      raw.connection.close({ type: 'S', name: 's' });
      raw.connection.parse({ name: 's', text: 'SELECT 555 AS n', types: [] });
    });
    raw.execute('s'); raw.connection.sync();
    await until(() => h.units[1]);
    expect(h.units.map(unit => unit.sql).some(sql => sql === 'SELECT 555 AS n')).toBe(false);
    expect(h.units).toHaveLength(2);
    await h.units[1]!.release(); await failed;
    const recovered = await until(() => h.units[2]);
    expect(recovered.sql).toBe('SELECT 111 AS n'); await recovered.release();
    await until(() => raw.rows.length === 1);
    const accepted = raw.cycle(() => raw.execute('accepted'));
    await (await until(() => h.units[3])).release(); await accepted;
    expect(raw.codes).toEqual(['42P05']); expect(raw.rows).toEqual([['111'], ['222']]);
    expect(h.units[3]!.sql).toBe('SELECT 222 AS n'); expect(h.errors).toEqual([]);
    await h.client.end();
  });
  test('preserves real errors and aborted transaction state through rollback and savepoints', async () => {
    await direct.query('INSERT INTO gate(id) VALUES (2) ON CONFLICT DO NOTHING');
    const h = await harness(true); await h.client.query('BEGIN'); await h.client.query('SAVEPOINT a');
    await expect(h.client.query('INSERT INTO gate(id) VALUES (2)')).rejects.toMatchObject({ code: '23505' });
    await expect(h.client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
    await h.client.query('ROLLBACK TO SAVEPOINT a'); await h.client.query('ROLLBACK');
    expect(h.completions.map(c => c.transactionStatus)).toEqual(['T', 'T', 'E', 'E', 'T', 'I']);
    expect(h.completions[2]!.error?.code).toBe('23505'); expect(h.errors).toEqual([]); await h.client.end();
  });
  test('rejects a second simultaneous connection and permits sequential generation reconnect', async () => {
    const h = await harness(true); const second = new Client({ connectionString: h.proxy.connectionString }); second.on('error', () => {});
    resources.at(-1)!.clients.push(second);
    await expect(second.connect()).rejects.toThrow(/one.*connection|simultaneous/i); await second.end();
    await h.client.query('SELECT 1'); await h.client.end();
    const third = new Client({ connectionString: h.proxy.connectionString }); third.on('error', () => {}); resources.at(-1)!.clients.push(third);
    await third.connect(); await third.query('SELECT 2'); await third.end();
    expect(h.units.map(u => [u.connection, u.ordinal])).toEqual([[0, 0], [1, 0]]);
    expect(h.errors[0]?.message).toMatch(/one.*connection|simultaneous/i);
  });
  test('reports accepted queryless startups across reconnects without exposing their values', async () => {
    const h = await harness(true);
    await h.client.end();
    const privateName = 'private-queryless-startup';
    const next = new Client({ connectionString: h.proxy.connectionString, application_name: privateName });
    next.on('error', () => {}); resources.at(-1)!.clients.push(next);
    await next.connect(); await next.query('SELECT 1'); await next.end();
    const startups = h.events.filter(event => event.type === 'startup');
    expect(startups.map(event => [event.actor, event.connection])).toEqual([
      ['test', 0],
      ['test', 1],
    ]);
    expect(startups.map(event => event.fingerprint)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(startups[0]!.fingerprint).not.toBe(startups[1]!.fingerprint);
    expect(JSON.stringify(startups)).not.toContain(privateName);
  });
  test('rejects duplicate database startup parameters before recording an accepted startup', async () => {
    const errors: Error[] = []; const events: ProxyEvent[] = [];
    const proxy = await createProxy({
      upstreamUrl: databaseUrl,
      actor: 'duplicate-db',
      onUnit() {},
      onEvent(event) { events.push(event); },
      onError(error) { errors.push(error); },
    });
    const stream = duplicateDatabaseStream('ignored_database_name');
    const client = new Client({ connectionString: proxy.connectionString, stream: () => stream });
    client.on('error', () => {}); resources.push({ proxy, clients: [client] });
    await expect(client.connect()).rejects.toThrow(/duplicate.*database/i);
    await until(() => errors[0]);
    expect(errors[0]!.message).toMatch(/duplicate.*database/i);
    expect(events.filter(event => event.type === 'startup')).toEqual([]);
  });
  test('rejects TLS-required clients and streaming COPY with actionable profile errors', async () => {
    const errors: Error[] = []; const proxy = await createProxy({ upstreamUrl: databaseUrl, actor: 'ssl', onUnit() {}, onError(e) { errors.push(e); } });
    const tls = new Client({ connectionString: proxy.connectionString, ssl: { rejectUnauthorized: false } }); tls.on('error', () => {}); resources.push({ proxy, clients: [tls] });
    await expect(tls.connect()).rejects.toThrow(/SSL|TLS/i); await tls.end();
    await until(() => errors.find(e => /TLS|SSL/.test(e.message)));
    const h = await harness(true); await expect(h.client.query('COPY gate TO STDOUT')).rejects.toThrow(/COPY/i);
    expect(h.errors.some(e => /unsupported.*COPY/i.test(e.message))).toBe(true);
  });
  test('rejects early Flush and oversized packets without process errors or backend leaks', async () => {
    const h = await harness(true); const pid = h.events.find(e => e.type === 'connected');
    (h.client as unknown as { connection: { stream: net.Socket } }).connection.stream.write(packet('H'));
    await until(() => h.errors.find(e => /Flush/.test(e.message)));
    await h.proxy.close();
    if (pid?.type === 'connected') {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!(await direct.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [pid.backendPid])).rowCount) break;
        await new Promise(r => setTimeout(r, 5));
      }
      expect((await direct.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [pid.backendPid])).rows).toEqual([]);
    }
    const errors: Error[] = []; const proxy = await createProxy({ upstreamUrl: databaseUrl, actor: 'large', maxMessageBytes: 64, onUnit() {}, onError(e) { errors.push(e); } }); resources.push({ proxy, clients: [] });
    const socket = await rawSocket(proxy.connectionString); socket.write(Buffer.from([0, 0, 1, 0]));
    await until(() => errors.find(e => /limit/.test(e.message))); socket.destroy(); await proxy.close();
  });
  test('holds Parse and Bind before a fragmented Sync, then preserves original driver results', async () => {
    const h = await harness();
    const stream = (h.client as unknown as { connection: { stream: net.Socket } }).connection.stream;
    const write = stream.write.bind(stream); let heldSync: Buffer | undefined;
    stream.write = ((chunk: Buffer, ...args: unknown[]) => {
      if (Buffer.isBuffer(chunk) && chunk[0] === 83) { heldSync = Buffer.from(chunk); return true; }
      return (write as (...args: unknown[]) => boolean)(chunk, ...args);
    }) as typeof stream.write;
    const result = h.client.query('SELECT $1::int AS n', [19]);
    await until(() => heldSync);
    expect(h.units).toHaveLength(0);
    const connected = h.events.find(e => e.type === 'connected');
    expect(connected?.type).toBe('connected');
    if (connected?.type === 'connected') expect((await direct.query('SELECT state, query FROM pg_stat_activity WHERE pid=$1', [connected.backendPid])).rows[0]).toMatchObject({ state: 'idle', query: '' });
    stream.write = write;
    for (const byte of heldSync!) write(Buffer.from([byte]));
    const unit = await until(() => h.units[0]); await unit.release();
    expect((await result).rows).toEqual([{ n: 19 }]); expect(h.errors).toEqual([]); await h.client.end();
  });
  test('forwards authentication errors without capturing credentials in harness errors', async () => {
    const errors: Error[] = []; const events: ProxyEvent[] = [];
    const proxy = await createProxy({ upstreamUrl: databaseUrl, actor: 'auth', onUnit() {}, onEvent(event) { events.push(event); }, onError(e) { errors.push(e); } });
    const wrongUrl = new URL(proxy.connectionString); wrongUrl.password = 'intentionally_wrong_private_password';
    const client = new Client({ connectionString: wrongUrl.toString() }); client.on('error', () => {}); resources.push({ proxy, clients: [client] });
    const code = await client.connect().then(() => 'connected', (e: { code: string }) => e.code);
    expect(code).toBe('28P01'); await client.end();
    expect(events.filter(event => event.type === 'startup')).toEqual([{
      type: 'startup', actor: 'auth', connection: 0, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(events.some(event => event.type === 'connected')).toBe(false);
    expect(JSON.stringify(errors.map(e => e.message))).not.toContain('intentionally_wrong_private_password');
  });
  test('catches scheduling callback errors inside the transport', async () => {
    const errors: Error[] = []; const proxy = await createProxy({ upstreamUrl: databaseUrl, actor: 'callback', onUnit() { throw new Error('private callback detail'); }, onError(e) { errors.push(e); throw new Error('consumer failure'); } });
    const client = new Client({ connectionString: proxy.connectionString }); client.on('error', () => {}); resources.push({ proxy, clients: [client] }); await client.connect();
    await expect(client.query('SELECT 1')).rejects.toThrow(/scheduling callback failed/);
    expect(errors.map(e => e.message)).toEqual(['Proxy scheduling callback failed']);
  });
  test('close rejects a held query through the protocol so an actor finally can end without an idle error event', async () => {
    const h = await harness(); h.client.removeAllListeners('error');
    const actor = (async () => { try { await h.client.query('SELECT 12'); } finally { await h.client.end(); } })();
    const failed = actor.catch((error: Error) => error.message);
    await until(() => h.units[0]); await h.proxy.close();
    expect(await failed).toMatch(/proxy closed before command completion/);
  });
  test('lets a driver terminate after ErrorResponse while retaining the final ReadyForQuery completion', async () => {
    const backend = await delayedErrorBackend();
    const proxyErrors: Error[] = []; const clientErrors: Error[] = []; const completions: UnitCompletion[] = []; const releaseErrors: Error[] = [];
    const proxy = await createProxy({
      upstreamUrl: backend.url, actor: 'error', onError(error) { proxyErrors.push(error); },
      onUnit(unit) { void unit.release().then(value => completions.push(value), error => releaseErrors.push(error)); },
    });
    const client = new Client({ connectionString: proxy.connectionString });
    client.on('error', error => clientErrors.push(error));
    try {
      await client.connect();
      await expect(client.query('SELECT * FROM missing_relation')).rejects.toMatchObject({ code: '42P01' });
      await client.end();
      expect(completions).toEqual([]);
      backend.finishQuery();
      await until(() => completions[0] ?? releaseErrors[0]);
      expect(completions).toEqual([{ transactionStatus: 'I', commandTags: [], rowCount: 0, error: { code: '42P01', message: 'x'.repeat('missing relation'.length) } }]);
      expect({ proxyErrors, clientErrors, releaseErrors }).toEqual({ proxyErrors: [], clientErrors: [], releaseErrors: [] });
    } finally {
      await proxy.close(); await client.end().catch(() => {}); await backend.close();
    }
  });
  test('resumes a paused backend while draining ReadyForQuery after an error-side Terminate', async () => {
    const backend = await delayedErrorBackend();
    const completions: UnitCompletion[] = [];
    const proxy = await createProxy({
      upstreamUrl: backend.url, actor: 'backpressure', onError() {},
      onUnit(unit) { void unit.release().then(value => completions.push(value), () => {}); },
    });
    const client = new Client({ connectionString: proxy.connectionString }); client.on('error', () => {});
    const originalWrite = net.Socket.prototype.write;
    const proxyPort = Number(new URL(proxy.connectionString).port);
    net.Socket.prototype.write = function (this: net.Socket, chunk: unknown, ...args: unknown[]) {
      const wrote = Reflect.apply(originalWrite, this, [chunk, ...args]) as boolean;
      if (this.localPort === proxyPort && Buffer.isBuffer(chunk) && chunk[0] === 'E'.charCodeAt(0)) return false;
      return wrote;
    } as typeof net.Socket.prototype.write;
    try {
      await client.connect();
      await expect(client.query('SELECT * FROM missing_relation')).rejects.toMatchObject({ code: '42P01' });
      await client.end();
      expect(completions).toEqual([]);
      backend.finishQuery();
      await until(() => completions[0]);
      expect(completions[0]).toMatchObject({ transactionStatus: 'I', error: { code: '42P01' } });
    } finally {
      net.Socket.prototype.write = originalWrite;
      await proxy.close(); await client.end().catch(() => {}); await backend.close();
    }
  });
  test('rejects a released error cycle if the backend closes before ReadyForQuery', async () => {
    const backend = await delayedErrorBackend();
    const proxyErrors: Error[] = []; const releaseErrors: Error[] = [];
    const proxy = await createProxy({
      upstreamUrl: backend.url, actor: 'truncated-error', onError(error) { proxyErrors.push(error); },
      onUnit(unit) { void unit.release().catch(error => releaseErrors.push(error)); },
    });
    const client = new Client({ connectionString: proxy.connectionString }); client.on('error', () => {});
    try {
      await client.connect();
      await expect(client.query('SELECT * FROM missing_relation')).rejects.toMatchObject({ code: '42P01' });
      await client.end();
      backend.finishQuery('close');
      await until(() => releaseErrors[0]);
      expect(releaseErrors[0]!.message).toMatch(/upstream.*disconnect/i);
      expect(proxyErrors.map(error => error.message)).toEqual([releaseErrors[0]!.message]);
    } finally {
      await proxy.close(); await client.end().catch(() => {}); await backend.close();
    }
  });
  test('rejects frontend protocol data sent after Terminate', async () => {
    const h = await harness();
    const stream = (h.client as unknown as { connection: { stream: net.Socket } }).connection.stream;
    stream.write(Buffer.concat([packet('X'), packet('Q', Buffer.from('SELECT 1\0'))]));
    const error = await until(() => h.errors[0]);
    expect(error.message).toBe('Actor sent protocol data after Terminate');
    expect(h.units).toEqual([]);
  });
  test('announces every cycle queued before startup ReadyForQuery even when callbacks release synchronously', async () => {
    const units: PendingUnit[] = []; const errors: Error[] = [];
    const proxy = await createProxy({ upstreamUrl: databaseUrl, actor: 'queued', onUnit(unit) { units.push(unit); if (units.length === 1) void unit.release().catch(e => errors.push(e)); }, onError(e) { errors.push(e); } });
    const stream = new net.Socket();
    stream.once('connect', () => {
    const write = stream.write.bind(stream); let initial = true;
    stream.write = ((chunk: Buffer, ...args: unknown[]) => {
      if (initial) { initial = false; chunk = Buffer.concat([chunk, packet('Q', Buffer.from('SELECT 71\0')), packet('Q', Buffer.from('SELECT 72\0'))]); }
      return (write as (...args: unknown[]) => boolean)(chunk, ...args);
    }) as typeof stream.write;
    });
    const client = new Client({ connectionString: proxy.connectionString, stream: () => stream }); client.on('error', () => {}); resources.push({ proxy, clients: [client] });
    await client.connect(); stream.removeAllListeners('data');
    await until(() => units.length === 2).catch(() => { expect({ units: units.map(u => u.sql), errors: errors.map(e => e.message) }).toEqual({ units: ['SELECT 71', 'SELECT 72'], errors: [] }); });
    expect(units.map(u => u.sql)).toEqual(['SELECT 71', 'SELECT 72']);
    // Raw queued messages intentionally bypass the driver's query queue in this protocol test.
    await until(() => units[1]);
    await proxy.close(); await client.end();
  });
  test('disconnect while held reports interruption and rejects later release', async () => {
    const h = await harness(); const result = h.client.query('SELECT 9'); void result.catch(() => {});
    const unit = await until(() => h.units[0]);
    (h.client as unknown as { connection: { stream: net.Socket } }).connection.stream.destroy();
    await until(() => h.errors[0]); await expect(unit.release()).rejects.toThrow(/closed|disconnect/i);
  });
});
