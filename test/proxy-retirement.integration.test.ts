import net, { type Socket } from 'node:net';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createOwnedDatabase } from '../src/database.js';
import { createProxy } from '../src/proxy.js';
import type { OwnedDatabase, ProxyEvent } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Expected retirement event was not observed')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

let database: OwnedDatabase;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => { database = await createOwnedDatabase(testDatabaseUrl()); });
afterEach(async () => {
  try { for (const close of cleanup.splice(0)) await close(); }
  finally { vi.restoreAllMocks(); }
});
afterAll(async () => {
  const name = new URL(database.connectionString).pathname.slice(1);
  await database.close();
  const admin = new Client({ connectionString: testDatabaseUrl() });
  await admin.connect();
  try {
    const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows;
    console.log(JSON.stringify({ proxyRetirementCleanup: { names: [name], remaining } }));
    expect(remaining).toEqual([]);
  } finally { await admin.end(); }
});

// Hold delivery of an actual socket close notification after the underlying
// socket has physically closed. PostgreSQL, authentication, driver close and all
// query bytes are real; only the two proxy-side notification orders are controlled.
async function harness(maxBufferedBytes?: number, onEvent?: (event: ProxyEvent) => void) {
  const frontHeld = deferred(); const backHeld = deferred();
  let releaseFront = () => {}; let releaseBack = () => {};
  const originalConnect = net.connect.bind(net);
  const originalServer = net.createServer.bind(net);
  const upstreams: Socket[] = []; const frontends: Socket[] = [];
  const arrivals: ReturnType<typeof deferred<Socket>>[] = [];
  function hold(socket: Socket, held: ReturnType<typeof deferred<void>>, setRelease: (release: () => void) => void) {
    const emit = socket.emit; let intercepted = false;
    socket.emit = ((event: string | symbol, ...values: unknown[]) => {
      if (event === 'close' && !intercepted) {
        intercepted = true;
        expect(socket.destroyed).toBe(true);
        setRelease(() => { Reflect.apply(emit, socket, [event, ...values]); });
        held.resolve();
        return true;
      }
      return Reflect.apply(emit, socket, [event, ...values]);
    }) as typeof socket.emit;
  }
  vi.spyOn(net, 'connect').mockImplementation(((...args: Parameters<typeof net.connect>) => {
    const socket = originalConnect(...args); upstreams.push(socket);
    if (upstreams.length === 1) hold(socket, backHeld, release => { releaseBack = release; });
    return socket;
  }) as typeof net.connect);
  vi.spyOn(net, 'createServer').mockImplementation(((...args: Parameters<typeof net.createServer>) => {
    const server = originalServer(...args);
    server.on('connection', socket => {
      frontends.push(socket);
      if (frontends.length === 1) hold(socket, frontHeld, release => { releaseFront = release; });
      arrivals[frontends.length - 1]?.resolve(socket);
    });
    return server;
  }) as typeof net.createServer);
  const events: ProxyEvent[] = []; const errors: Error[] = [];
  const proxy = await createProxy({ upstreamUrl: database.connectionString, actor: 'worker',
    ...(maxBufferedBytes === undefined ? {} : { maxBufferedBytes }),
    onEvent: event => { events.push(event); onEvent?.(event); }, onError: error => { errors.push(error); },
    onUnit: unit => { void unit.release().catch(error => errors.push(error)); },
  });
  const clients: Client[] = []; const raw: Socket[] = [];
  function client() {
    const value = new Client({ connectionString: proxy.connectionString });
    value.on('error', () => {}); clients.push(value); return value;
  }
  const owner = client();
  async function retire() {
    await owner.end(); await bounded(Promise.all([frontHeld.promise, backHeld.promise]));
  }
  function arrival(index: number) {
    if (frontends[index]) return Promise.resolve(frontends[index]!);
    return (arrivals[index] ??= deferred<Socket>()).promise;
  }
  function connectRaw() {
    const url = new URL(proxy.connectionString);
    const socket = originalConnect({ host: url.hostname, port: Number(url.port) });
    socket.on('error', () => {}); socket.resume(); raw.push(socket); return socket;
  }
  function startup() {
    const url = new URL(database.connectionString);
    const fields = Buffer.from(`user\0${decodeURIComponent(url.username)}\0database\0${decodeURIComponent(url.pathname.slice(1))}\0\0`);
    const head = Buffer.alloc(8); head.writeInt32BE(head.length + fields.length); head.writeInt32BE(196608, 4);
    return Buffer.concat([head, fields]);
  }
  cleanup.push(async () => {
    releaseFront(); releaseBack(); raw.forEach(socket => socket.destroy());
    await proxy.close(); await Promise.all(clients.map(value => value.end()));
  });
  await owner.connect();
  expect((await owner.query('SELECT 41 AS n')).rows).toEqual([{ n: 41 }]);
  return { proxy, owner, client, retire, arrival, connectRaw, startup, events, errors, upstreams,
    releaseFront: () => { releaseFront(); releaseFront = () => {}; },
    releaseBack: () => { releaseBack(); releaseBack = () => {}; } };
}

test('replacement authenticates and gets a generation only after both original socket close notifications', async () => {
  const h = await harness(); await h.retire();
  const replacement = h.client(); const connected = replacement.connect();
  await bounded(h.arrival(1));
  expect(h.upstreams).toHaveLength(1);
  expect(h.events.filter(event => event.type === 'startup')).toHaveLength(1);
  h.releaseFront(); await Promise.resolve();
  expect(h.upstreams).toHaveLength(1);
  expect(h.events.filter(event => event.type === 'disconnected')).toHaveLength(0);
  h.releaseBack(); await bounded(connected);
  expect((await replacement.query('SELECT 42 AS n')).rows).toEqual([{ n: 42 }]);
  expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0, 1]);
  expect(h.events.findIndex(event => event.type === 'disconnected' && event.connection === 0))
    .toBeLessThan(h.events.findIndex(event => event.type === 'startup' && event.connection === 1));
  expect(h.errors).toEqual([]);
});

test.each([false, true])('pending FIN is discarded before retirement without consuming a generation (startup bytes %s)', async withStartup => {
  const h = await harness(); await h.retire();
  const raw = h.connectRaw(); const pending = await bounded(h.arrival(1));
  const ended = new Promise<void>(resolve => pending.once('end', resolve));
  if (withStartup) raw.end(h.startup()); else raw.end();
  await bounded(ended);
  const closed = new Promise<void>(resolve => pending.destroyed ? resolve() : pending.once('close', resolve));
  await bounded(closed);
  expect(h.upstreams).toHaveLength(1);
  h.releaseFront(); h.releaseBack();
  const replacement = h.client(); await replacement.connect();
  expect((await replacement.query('SELECT 43 AS n')).rows).toEqual([{ n: 43 }]);
  expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0, 1]);
  expect(h.errors).toEqual([]);
});

test('live overlap and a second pending replacement remain rejected without backend admission', async () => {
  const h = await harness();
  await expect(h.client().connect()).rejects.toThrow(/one simultaneous physical connection/i);
  await h.retire();
  const pending = h.client(); const connected = pending.connect();
  await bounded(h.arrival(2));
  await expect(h.client().connect()).rejects.toThrow(/one simultaneous physical connection/i);
  expect(h.upstreams).toHaveLength(1);
  h.releaseFront(); h.releaseBack(); await bounded(connected);
  expect((await pending.query('SELECT 44 AS n')).rows).toEqual([{ n: 44 }]);
  expect(h.errors).toHaveLength(2);
});

test('closing the proxy drains a pending replacement without starting another backend', async () => {
  const h = await harness(); await h.retire();
  const raw = h.connectRaw(); await bounded(h.arrival(1)); raw.write(h.startup());
  const closed = new Promise<void>(resolve => raw.once('close', resolve));
  const proxyClosed = h.proxy.close(); await bounded(closed);
  expect(h.upstreams).toHaveLength(1);
  h.releaseFront(); h.releaseBack(); await bounded(proxyClosed);
  expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0]);
  expect(h.events.filter(event => event.type === 'disconnected').map(event => event.connection)).toEqual([0]);
  expect(h.errors).toEqual([]);
});

test('pending uninterpreted startup bytes obey the existing buffer limit', async () => {
  const h = await harness(1024); await h.retire();
  const raw = h.connectRaw(); await bounded(h.arrival(1));
  const closed = new Promise<void>(resolve => raw.once('close', resolve));
  raw.write(Buffer.alloc(1025, 97)); await bounded(closed);
  expect(h.errors.map(error => error.message)).toEqual([expect.stringMatching(/buffered-byte limit/i)]);
  expect(h.upstreams).toHaveLength(1);
  h.releaseFront(); h.releaseBack();
  const replacement = h.client(); await replacement.connect();
  expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0, 1]);
});

test('repeated abandoned startups while retirement is held do not consume generations', async () => {
  const h = await harness(); await h.retire();
  for (let index = 0; index < 32; index++) {
    const raw = h.connectRaw(); const pending = await bounded(h.arrival(index + 1));
    const closed = new Promise<void>(resolve => pending.once('close', resolve));
    raw.end(h.startup()); await bounded(closed);
  }
  expect(h.upstreams).toHaveLength(1);
  h.releaseFront(); h.releaseBack();
  const replacement = h.client(); await replacement.connect();
  expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0, 1]);
  expect(h.errors).toEqual([]);
});

test('resetting a pending frontend frees its reservation without admitting its buffered startup', async () => {
  const h = await harness(); await h.retire();
  const raw = h.connectRaw(); const pending = await bounded(h.arrival(1));
  const closed = new Promise<void>(resolve => pending.once('close', resolve));
  raw.write(h.startup()); raw.resetAndDestroy(); await bounded(closed);
  expect(h.upstreams).toHaveLength(1);
  const replacement = h.client(); const connected = replacement.connect();
  await bounded(h.arrival(2));
  h.releaseFront(); h.releaseBack(); await bounded(connected);
  expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0, 1]);
  expect(h.errors).toEqual([]);
});

test('deferred upstream creation failure is reported and closes the pending frontend', async () => {
  const h = await harness(); await h.retire();
  const replacement = h.client();
  const rejected = expect(replacement.connect()).rejects.toThrow(/terminated|ECONNRESET/i);
  await bounded(h.arrival(1));
  vi.mocked(net.connect).mockImplementationOnce(() => { throw new Error('injected upstream creation failure'); });
  h.releaseFront(); h.releaseBack(); await bounded(rejected);
  expect(h.errors.map(error => error.message)).toEqual(['injected upstream creation failure']);
  expect(h.upstreams).toHaveLength(1);
  expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0]);
});

test('shutdown requested from original disconnection callback prevents deferred admission', async () => {
  let close: Promise<void> | undefined;
  const h = await harness(undefined, event => {
    if (event.type === 'disconnected' && event.connection === 0) close = h.proxy.close();
  });
  await h.retire();
  const raw = h.connectRaw(); await bounded(h.arrival(1)); raw.write(h.startup());
  const closed = new Promise<void>(resolve => raw.once('close', resolve));
  h.releaseFront(); h.releaseBack(); await bounded(closed); await bounded(close!);
  expect(h.upstreams).toHaveLength(1);
  expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0]);
  expect(h.errors).toEqual([]);
});
