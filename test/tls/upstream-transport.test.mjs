import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, appendFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { TLSSocket } from 'node:tls';
import { inspect } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import { withTlsTestServer } from '../../scripts/tls-test-server.mjs';
import { tlsTestCommand } from '../../scripts/tls-test-command.mjs';
import { resolvePostgresTransport } from '../../dist/postgres-transport.js';
import { connectPostgresUpstream } from '../../dist/protocol/upstream-transport.js';

const evidence = process.env.INTERLEAVE_TLS_CONNECTOR_EVIDENCE;
async function record(value) { if (evidence) await appendFile(evidence, JSON.stringify(value) + '\n'); }
function transport(server, ca = server.certificates.ca) {
  const url = new URL('postgres://127.0.0.1/postgres');
  url.port = String(server.connection.port); url.username = server.connection.user; url.password = server.connection.password;
  return resolvePostgresTransport(url.toString(), { mode: 'verify-full', ca });
}
async function rejectsSafely(operation, code, server) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code);
    const emitted = inspect(error) + JSON.stringify(error);
    for (const secret of [server.connection.password, server.certificates.directory, 'BEGIN CERTIFICATE', 'BEGIN PRIVATE KEY']) assert(!emitted.includes(secret));
    return true;
  });
}
async function absent(identity) {
  for (const target of [identity.name, identity.id]) {
    await assert.rejects(tlsTestCommand('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', target]), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, new RegExp(`No such (?:object|container): ${target}\\s*$`)); return true;
    });
  }
  await record({ type: 'verified-absent', identity });
}
async function owned(options, use) {
  let identity, directory;
  const events = [];
  try {
    await withTlsTestServer({ ...options, onEvent: event => { events.push(event); if (event.type === 'ready') identity = event.identity; } }, async server => {
      directory = server.certificates.directory;
      await use(server);
    });
  } finally {
    for (const event of events) await record(event);
    if (identity) await absent(identity);
    if (directory) { await assert.rejects(access(directory), { code: 'ENOENT' }); await record({ type: 'certificate-directory-absent' }); }
  }
}

// This fixture only pipes original bytes after the connector resolves. It is not
// the scheduling proxy. A real driver owns SCRAM and query framing end to end.
async function throughConnector(server, use) {
  const sockets = new Set(), closed = [], tasks = [], errors = [], observed = [];
  const relay = createServer(actor => {
    sockets.add(actor); closed.push(new Promise(resolve => actor.once('close', resolve)));
    actor.pause(); actor.on('error', () => undefined);
    const task = (async () => {
      const upstream = await connectPostgresUpstream(transport(server));
      assert(upstream instanceof TLSSocket); assert.equal(upstream.authorized, true);
      sockets.add(upstream); closed.push(new Promise(resolve => upstream.once('close', resolve)));
      upstream.on('error', () => actor.destroy());
      actor.once('close', () => upstream.destroy()); upstream.once('close', () => actor.destroy());
      observed.push({ encrypted: upstream.encrypted, authorized: upstream.authorized, protocol: upstream.getProtocol() });
      actor.pipe(upstream); upstream.pipe(actor); actor.resume();
    })().catch(error => { errors.push(error); actor.destroy(); });
    tasks.push(task);
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  try {
    await use({ ...server.connection, port: relay.address().port, ssl: false, sslnegotiation: 'postgres', enableChannelBinding: false,
      connectionTimeoutMillis: 3_000, query_timeout: 3_000 });
  } finally {
    const stopped = once(relay, 'close'); relay.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all(tasks);
    for (const socket of sockets) socket.destroy();
    await Promise.all(closed); await stopped;
    assert.deepEqual(errors, []);
    assert([...sockets].every(socket => socket.closed));
    await record({ type: 'relay-closed', socketCount: sockets.size, observations: observed });
  }
}

test('verified connector carries real SCRAM, prepared parameters, transaction bytes and authentication rejection', { timeout: 240_000 }, async () => {
  await owned({}, async server => {
    await rejectsSafely(connectPostgresUpstream(transport(server, server.certificates.unrelatedCa)), 'upstream-tls-verification-failed', server);
    await throughConnector(server, async config => {
      const client = new pg.Client(config); client.on('error', () => {});
      try {
        await client.connect();
        await client.query('BEGIN');
        const result = await client.query({ name: 'connector-fixture', text: 'SELECT $1::int AS value, ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()', values: [42] });
        assert.equal(result.rows[0].value, 42); assert.equal(result.rows[0].ssl, true); assert.match(result.rows[0].version, /^TLSv1\.[23]$/);
        await client.query('ROLLBACK');
        await record({ type: 'real-query', value: result.rows[0].value, ssl: result.rows[0].ssl, protocol: result.rows[0].version });
      } finally { await client.end(); }
      const wrong = new pg.Client({ ...config, password: 'deliberately-wrong-fixture-password' }); wrong.on('error', () => {});
      try { await assert.rejects(wrong.connect(), { code: '28P01' }); await record({ type: 'authentication-rejection', code: '28P01' }); }
      finally { await wrong.end(); }
    });
  });
});

for (const [leaf, code] of [['wrongName', 'upstream-certificate-name-mismatch'], ['expired', 'upstream-tls-verification-failed'], ['future', 'upstream-tls-verification-failed']]) {
  test(`connector rejects same-CA ${leaf} before handing out a stream`, { timeout: 240_000 }, async () => {
    await owned({ leaf }, async server => {
      await rejectsSafely(connectPostgresUpstream(transport(server)), code, server);
      await record({ type: 'certificate-rejection', leaf, code });
    });
  });
}
