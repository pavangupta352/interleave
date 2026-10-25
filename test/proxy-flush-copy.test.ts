import net from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { createProxy } from '../src/proxy.js';
import type { ActorProxy, PendingUnit, UnitCompletion } from '../src/types.js';

const message = (type: string, body = Buffer.alloc(0)) => { const header = Buffer.alloc(5); header.write(type, 0, 'latin1'); header.writeUInt32BE(body.length + 4, 1); return Buffer.concat([header, body]); };
const cstring = (value: string) => Buffer.from(value + '\0');
const int16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
const int32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };
const resources: { proxy: ActorProxy; server: net.Server; client: net.Socket }[] = [];
afterEach(async () => {
  for (const { proxy, server, client } of resources.splice(0)) { client.destroy(); await proxy.close(); server.close(); }
});
async function until<T>(read: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for proxy evidence');
}

// A server that answers an extended COPY the way PostgreSQL does: CopyInResponse after
// the Flush, CommandComplete after CopyDone, and ReadyForQuery only once Sync arrives.
function copyServer(): Promise<net.Server> {
  const server = net.createServer(socket => {
    let buffered = Buffer.alloc(0); let started = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (!started) {
          if (buffered.length < 4 || buffered.length < buffered.readUInt32BE(0)) return;
          buffered = buffered.subarray(buffered.readUInt32BE(0)); started = true;
          socket.write(Buffer.concat([message('R', int32(0)), message('K', Buffer.concat([int32(4242), int32(7)])), message('Z', Buffer.from('I'))]));
          continue;
        }
        if (buffered.length < 5 || buffered.length < buffered.readUInt32BE(1) + 1) return;
        const type = String.fromCharCode(buffered[0]!); buffered = buffered.subarray(buffered.readUInt32BE(1) + 1);
        if (type === 'H') socket.write(Buffer.concat([message('1'), message('2'), message('G', Buffer.concat([Buffer.from([0]), int16(0)]))]));
        else if (type === 'c') socket.write(message('C', cstring('COPY 1')));
        else if (type === 'S') socket.write(message('Z', Buffer.from('I')));
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('the Sync after a Flush stage\'s CopyDone becomes the cycle\'s own Sync release, even in one write', async () => {
  const server = await copyServer();
  const units: PendingUnit[] = []; const completions: UnitCompletion[] = []; const errors: string[] = [];
  const proxy = await createProxy({
    actor: 'alice', upstreamUrl: `postgres://alice@127.0.0.1:${(server.address() as net.AddressInfo).port}/db`, protocolProfile: 'flush-stages-v1',
    onUnit(unit) { units.push(unit); void unit.release().then(completion => completions.push(completion), error => errors.push(error.message)); },
    onError(error) { errors.push(error.message); },
  });
  const client = net.connect(Number(new URL(proxy.connectionString).port), '127.0.0.1');
  resources.push({ proxy, server, client });
  client.on('error', () => {}); client.on('data', () => {});
  await new Promise(resolve => client.once('connect', resolve));
  const startup = Buffer.concat([int32(196608), cstring('user'), cstring('alice'), cstring('database'), cstring('db'), Buffer.from([0])]);
  client.write(Buffer.concat([int32(startup.length + 4), startup]));
  client.write(Buffer.concat([
    message('P', Buffer.concat([cstring(''), cstring('COPY items FROM STDIN'), int16(0)])),
    message('B', Buffer.concat([cstring(''), cstring(''), int16(0), int16(0), int16(0)])),
    message('E', Buffer.concat([cstring(''), int32(0)])),
    message('H'),
  ]));
  await until(() => completions.length === 0 && units.length === 1 && units[0]);
  // The scheduler lets an actor's other connections run only while a unit is inside COPY.
  await until(() => units[0]!.copying?.());
  // libpq ends an extended copy with CopyData, CopyDone and Sync in one write.
  await new Promise(resolve => setTimeout(resolve, 50));
  client.write(Buffer.concat([message('d', Buffer.from('1\n')), message('c'), message('S')]));
  await until(() => completions.length === 2);
  expect(errors).toEqual([]);
  expect(units.map(unit => unit.stage)).toEqual(['flush', 'sync']);
  expect(units.map(unit => unit.copying?.())).toEqual([false, false]);
  expect(completions).toEqual([
    { kind: 'flush', commandTags: ['COPY 1'], rows: 0, copy: [{ direction: 'in', bytes: 2, sha256: createHash('sha256').update('1\n').digest('hex') }] },
    { kind: 'ready', transactionStatus: 'I', commandTags: [], rowCount: 0 },
  ]);
});
