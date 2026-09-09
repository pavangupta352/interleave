import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createOwnedDatabase } from '../src/database.js';
import { createProxy } from '../src/proxy.js';
import type { ActorProxy, OwnedDatabase, PendingUnit, ProxyEvent } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

let database: OwnedDatabase;
const resources: { proxy: ActorProxy; clients: Client[] }[] = [];

async function until<T>(predicate: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for auxiliary connection evidence');
}

async function harness(maxConnectionsPerActor?: number) {
  const units: PendingUnit[] = [];
  const events: ProxyEvent[] = [];
  const errors: Error[] = [];
  const proxy = await createProxy({
    upstreamUrl: database.connectionString, actor: 'worker',
    ...(maxConnectionsPerActor === undefined ? {} : { maxConnectionsPerActor }),
    onUnit(unit) { units.push(unit); },
    onEvent(event) { events.push(event); },
    onError(error) { errors.push(error); },
  });
  const clients: Client[] = [];
  resources.push({ proxy, clients });
  async function connect(name: string) {
    const client = new Client({ connectionString: proxy.connectionString, application_name: name });
    client.on('error', () => {});
    clients.push(client);
    await client.connect();
    return client;
  }
  async function query(client: Client, sql: string) {
    const count = units.length;
    const result = client.query(sql);
    void result.catch(() => {});
    const unit = await until(() => units[count]);
    await unit.release();
    return result;
  }
  return { proxy, connect, query, clients, units, events, errors };
}

describe('bounded auxiliary PostgreSQL connections', () => {
  beforeAll(async () => {
    database = await createOwnedDatabase(testDatabaseUrl());
    await database.db.query('CREATE TABLE auxiliary_effects (id integer PRIMARY KEY)');
  });
  afterEach(async () => {
    for (const { proxy, clients } of resources.splice(0)) {
      await proxy.close();
      await Promise.all(clients.map(client => client.end()));
    }
    await database.db.query('TRUNCATE auxiliary_effects');
  });
  afterAll(async () => { await database?.close(); });

  test('a queryless monitor and one command session preserve scheduling and startup identities', async () => {
    const h = await harness(2);
    await h.connect('private-monitor-name');
    const worker = await h.connect('private-worker-name');
    const result = worker.query('INSERT INTO auxiliary_effects VALUES (11)');
    void result.catch(() => {});
    const unit = await until(() => h.units[0]);
    expect(unit).toMatchObject({ actor: 'worker', connection: 1, ordinal: 0 });
    expect((await database.db.query('SELECT * FROM auxiliary_effects')).rows).toEqual([]);
    await unit.release();
    expect((await result).rowCount).toBe(1);
    expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0, 1]);
    const startups = h.events.filter(event => event.type === 'startup');
    expect(startups[0]!.fingerprint).not.toBe(startups[1]!.fingerprint);
    expect(JSON.stringify(startups)).not.toContain('private-');
    const monitor = h.events.find(event => event.type === 'connected' && event.connection === 0);
    expect(monitor?.type).toBe('connected');
    if (monitor?.type === 'connected') {
      expect((await database.db.query('SELECT state, query FROM pg_stat_activity WHERE pid=$1', [monitor.backendPid])).rows).toEqual([{ state: 'idle', query: '' }]);
    }
    expect(h.errors).toEqual([]);
  });

  test.each(['simple', 'extended'])('rejects another live %s command producer after the owner completed a command', async protocol => {
    const h = await harness(2);
    const owner = await h.connect('owner');
    const contender = await h.connect('contender');
    expect((await h.query(owner, 'SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
    const rejected = protocol === 'simple'
      ? contender.query('INSERT INTO auxiliary_effects VALUES (12)')
      : contender.query('INSERT INTO auxiliary_effects VALUES ($1)', [12]);
    await expect(rejected).rejects.toThrow(/one.*command-producing.*connection/i);
    expect(h.units).toHaveLength(1);
    expect((await database.db.query('SELECT * FROM auxiliary_effects')).rows).toEqual([]);
    expect((await h.query(owner, 'SELECT 2 AS n')).rows).toEqual([{ n: 2 }]);
    expect(h.errors.map(error => error.message)).toEqual([expect.stringMatching(/one.*command-producing.*connection/i)]);
  });

  test('an incomplete extended cycle reserves command ownership before Sync', async () => {
    const h = await harness(2);
    const owner = await h.connect('partial-owner');
    const stream = (owner as unknown as { connection: { stream: net.Socket } }).connection.stream;
    const payload = Buffer.concat([Buffer.from('held_statement\0INSERT INTO auxiliary_effects VALUES (13)\0'), Buffer.from([0, 0])]);
    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 'P'.charCodeAt(0); frame.writeInt32BE(payload.length + 4, 1); payload.copy(frame, 5);
    stream.write(frame);
    const contender = await h.connect('partial-contender');
    await expect(contender.query('INSERT INTO auxiliary_effects VALUES (14)')).rejects.toThrow(/one.*command-producing.*connection/i);
    expect(h.units).toEqual([]);
    expect((await database.db.query('SELECT * FROM auxiliary_effects')).rows).toEqual([]);
  });

  test('an already connected auxiliary session can take ownership only after owner closure', async () => {
    const h = await harness(2);
    const owner = await h.connect('first-owner');
    const auxiliary = await h.connect('next-owner');
    await h.query(owner, 'SELECT 1');
    await owner.end();
    await until(() => h.events.find(event => event.type === 'disconnected' && event.connection === 0));
    expect((await h.query(auxiliary, 'SELECT 2 AS n')).rows).toEqual([{ n: 2 }]);
    expect(h.units.map(unit => [unit.connection, unit.ordinal])).toEqual([[0, 0], [1, 0]]);
    expect(h.errors).toEqual([]);
  });

  test('the session cap rejects repeatedly and a closed auxiliary frees a slot for sequential reconnect', async () => {
    const h = await harness(2);
    const monitor = await h.connect('monitor');
    const owner = await h.connect('owner');
    await expect(h.connect('over-limit-1')).rejects.toThrow(/connection.*limit.*2/i);
    await expect(h.connect('over-limit-2')).rejects.toThrow(/connection.*limit.*2/i);
    await monitor.end();
    await until(() => h.events.find(event => event.type === 'disconnected' && event.connection === 0));
    await h.connect('replacement-monitor');
    await h.query(owner, 'SELECT 1');
    expect(h.events.filter(event => event.type === 'startup').map(event => event.connection)).toEqual([0, 1, 2]);
    expect(h.errors).toHaveLength(2);
  });

  test('default profile still rejects a second queryless physical connection', async () => {
    const h = await harness();
    await h.connect('default-first');
    await expect(h.connect('default-second')).rejects.toThrow('one simultaneous physical connection per actor is supported');
    expect(h.events.filter(event => event.type === 'startup')).toHaveLength(1);
  });

  test('connections still waiting for startup count toward the cap', async () => {
    const h = await harness(2);
    const address = new URL(h.proxy.connectionString);
    for (let index = 0; index < 2; index++) {
      const socket = net.connect({ host: address.hostname, port: Number(address.port) });
      socket.on('error', () => {});
      await new Promise<void>(resolve => socket.once('connect', resolve));
    }
    await expect(h.connect('over-cap-during-startup')).rejects.toThrow(/connection.*limit.*2/i);
    expect(h.events.filter(event => event.type === 'startup')).toEqual([]);
  });

  test('close rejects held work and closes its queryless auxiliary too', async () => {
    const h = await harness(2);
    await h.connect('monitor');
    const worker = await h.connect('held-worker');
    const result = worker.query('INSERT INTO auxiliary_effects VALUES (15)');
    const rejected = expect(result).rejects.toThrow(/proxy closed before command completion/i);
    await until(() => h.units[0]);
    await h.proxy.close();
    await rejected;
    expect(h.events.filter(event => event.type === 'disconnected').map(event => event.connection).sort()).toEqual([0, 1]);
    expect((await database.db.query('SELECT * FROM auxiliary_effects')).rows).toEqual([]);
  });

  test('close waits for every accepted session and removes all their PostgreSQL backends', async () => {
    const h = await harness(8);
    for (let index = 0; index < 8; index++) await h.connect(`session-${index}`);
    const backends = h.events.filter(event => event.type === 'connected').map(event => event.backendPid);
    expect(backends).toHaveLength(8);
    await h.query(h.clients[6]!, 'SELECT 1');
    await h.proxy.close();
    expect(h.events.filter(event => event.type === 'disconnected').map(event => event.connection).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await database.db.query('SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[])', [backends])).rowCount === 0) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect((await database.db.query('SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[])', [backends])).rows).toEqual([]);
    await h.proxy.close();
  });

  test.each([0, -1, 1.5, 9, Number.NaN, Number.POSITIVE_INFINITY, null, '2', true])('rejects invalid connection limit %s before listening', async limit => {
    await expect(harness(limit as number)).rejects.toThrow(/maxConnectionsPerActor.*integer.*1.*8/i);
  });
});
