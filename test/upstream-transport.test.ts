import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { rootCertificates } from 'node:tls';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';
import { resolvePostgresTransport } from '../src/postgres-transport.js';
import { connectPostgresUpstream } from '../src/protocol/upstream-transport.js';

const sslRequest = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const ca = rootCertificates[0]!;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withPeer(
  accept: (socket: Socket, bytes: Buffer) => void,
  use: (url: string, peers: Set<Socket>, received: Buffer[]) => Promise<void>,
): Promise<void> {
  const peers = new Set<Socket>();
  const received: Buffer[] = [];
  const server = createServer(socket => {
    peers.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => peers.delete(socket));
    let bytes = Buffer.alloc(0), handled = false;
    socket.on('data', chunk => {
      received.push(chunk);
      if (handled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 8) { handled = true; accept(socket, bytes); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test peer did not bind a TCP port');
  try { await use(`postgres://user:credential-sentinel@127.0.0.1:${address.port}/fixture`, peers, received); }
  finally {
    const closed = once(server, 'close');
    for (const socket of peers) socket.destroy();
    server.close();
    await closed;
  }
}

async function peersAbsent(peers: Set<Socket>): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (peers.size && performance.now() < deadline) await delay(5);
  expect(peers.size).toBe(0);
}

async function rejection(operation: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code });
  for (const sentinel of ['credential-sentinel', 'untrusted-peer-sentinel', 'BEGIN CERTIFICATE', 'abort-sentinel']) {
    expect(inspect(failure)).not.toContain(sentinel);
    expect(JSON.stringify(failure)).not.toContain(sentinel);
  }
}

describe('owned upstream negotiation', () => {
  it('returns a connected plaintext socket without sending an SSLRequest or rewriting bytes', async () => {
    await withPeer((socket, bytes) => socket.end(bytes), async (url, peers, received) => {
      const controller = new AbortController();
      const socket = await connectPostgresUpstream(resolvePostgresTransport(url), { signal: controller.signal });
      socket.on('error', () => undefined);
      expect(socket.connecting).toBe(false);
      expect(received).toHaveLength(0);
      controller.abort(new Error('abort-sentinel'));
      expect(socket.destroyed).toBe(false); // Cancellation ownership ended at handoff.
      const reply = once(socket, 'data');
      const closed = once(socket, 'close');
      const original = Buffer.from('original-caller-bytes');
      socket.end(original);
      expect((await reply)[0]).toEqual(original);
      await closed;
      await peersAbsent(peers);
    });
  });

  it.each([
    [Buffer.from('N'), 'upstream-tls-unavailable'],
    [Buffer.from('X'), 'upstream-negotiation-failed'],
    [Buffer.from('Suntrusted-peer-sentinel'), 'upstream-negotiation-failed'],
    [Buffer.from('Euntrusted-peer-sentinel'), 'upstream-negotiation-failed'],
  ])('rejects negotiation response %# and closes its owned socket without fallback', async (response, code) => {
    await withPeer((socket, request) => {
      expect(request).toEqual(sslRequest);
      socket.write(response);
    }, async (url, peers, received) => {
      await rejection(connectPostgresUpstream(resolvePostgresTransport(url, { mode: 'verify-full', ca })), code);
      await peersAbsent(peers);
      expect(Buffer.concat(received)).toEqual(sslRequest);
    });
  });

  it('rejects peer close before its negotiation response', async () => {
    await withPeer(socket => socket.end(), async (url, peers) => {
      await rejection(connectPostgresUpstream(resolvePostgresTransport(url, { mode: 'verify-full', ca })), 'upstream-closed');
      await peersAbsent(peers);
    });
  });

  it('rejects delayed plaintext after S as a failed TLS handshake', async () => {
    await withPeer(socket => {
      socket.write('S');
      socket.once('data', () => socket.end('untrusted-peer-sentinel'));
    }, async (url, peers) => {
      await rejection(connectPostgresUpstream(resolvePostgresTransport(url, { mode: 'verify-full', ca })), 'upstream-tls-handshake-failed');
      await peersAbsent(peers);
    });
  });

  it.each(['negotiation', 'handshake'])('times out a stalled %s and settles socket cleanup', async phase => {
    await withPeer(socket => { if (phase === 'handshake') socket.write('S'); }, async (url, peers) => {
      const started = performance.now();
      await rejection(connectPostgresUpstream(resolvePostgresTransport(url, { mode: 'verify-full', ca }), { timeoutMs: 60 }), 'upstream-timeout');
      expect(performance.now() - started).toBeLessThan(1_000);
      await peersAbsent(peers);
    });
  });

  it('applies the five-second default deadline when none is supplied', async () => {
    await withPeer(() => undefined, async (url, peers) => {
      const started = performance.now();
      await rejection(connectPostgresUpstream(resolvePostgresTransport(url, { mode: 'verify-full', ca })), 'upstream-timeout');
      expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
      expect(performance.now() - started).toBeLessThan(7_000);
      await peersAbsent(peers);
    });
  });

  it.each(['negotiation', 'handshake'])('aborts during %s and redacts the supplied reason', async phase => {
    const controller = new AbortController();
    await withPeer(socket => {
      if (phase === 'handshake') {
        socket.write('S');
        socket.once('data', () => controller.abort(new Error('abort-sentinel')));
      } else controller.abort(new Error('abort-sentinel'));
    }, async (url, peers) => {
      await rejection(connectPostgresUpstream(resolvePostgresTransport(url, { mode: 'verify-full', ca }), { signal: controller.signal }), 'upstream-aborted');
      await peersAbsent(peers);
    });
  });

  it('does not contact the server when already aborted', async () => {
    await withPeer(() => undefined, async (url, peers, received) => {
      const controller = new AbortController(); controller.abort(new Error('abort-sentinel'));
      await rejection(connectPostgresUpstream(resolvePostgresTransport(url), { signal: controller.signal }), 'upstream-aborted');
      await delay(20);
      expect(peers.size).toBe(0); expect(received).toHaveLength(0);
    });
  });

  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])('rejects an invalid deadline %# without opening a socket', async timeoutMs => {
    await withPeer(() => undefined, async (url, peers) => {
      await rejection(connectPostgresUpstream(resolvePostgresTransport(url), { timeoutMs }), 'upstream-invalid-options');
      expect(peers.size).toBe(0);
    });
  });

  it('reports connection refusal without echoing endpoint credentials', async () => {
    let url = '';
    await withPeer(() => undefined, async value => { url = value; });
    await rejection(connectPostgresUpstream(resolvePostgresTransport(url)), 'upstream-connection-failed');
  });
});
