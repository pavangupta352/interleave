import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { checkServerIdentity } from 'node:tls';
import { promisify } from 'node:util';
import pg from 'pg';
import test from 'node:test';
import { withTlsTestServer } from '../../scripts/tls-test-server.mjs';

const execute = promisify(execFile);
async function connect(server, { ca = server.certificates.ca, name = 'localhost', password = server.connection.password, plaintext = false } = {}) {
  const client = new pg.Client({ ...server.connection, password, connectionTimeoutMillis: 2000, query_timeout: 2000,
    enableChannelBinding: false, ssl: plaintext ? false : { ca, rejectUnauthorized: true,
      servername: name === '127.0.0.1' ? undefined : name, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
      checkServerIdentity: (_, certificate) => checkServerIdentity(name, certificate) } });
  client.on('error', () => {});
  try { await client.connect(); return await client.query('SELECT $1::int AS value, ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()', [42]); }
  finally { await client.end(); }
}
async function absent(identity) {
  for (const target of [identity.name, identity.id]) {
    await assert.rejects(execute('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', target]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, new RegExp(`No such (?:object|container): ${target}\\s*$`));
      return true;
    });
  }
}

test('owned TLS-only server permits verified DNS/IP and rejects unrelated trust, password and plaintext', { timeout: 240_000 }, async () => {
  let identity;
  await withTlsTestServer({ onEvent: event => { if (event.type === 'ready') identity = event.identity; } }, async server => {
    for (const name of ['localhost', '127.0.0.1']) {
      const result = await connect(server, { name });
      assert.equal(result.rows[0].value, 42); assert.equal(result.rows[0].ssl, true);
      assert.match(result.rows[0].version, /^TLSv1\.[23]$/);
    }
    await assert.rejects(connect(server, { ca: server.certificates.unrelatedCa }), error => ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
    await assert.rejects(connect(server, { password: 'deliberately-wrong-fixture-password' }), { code: '28P01' });
    await assert.rejects(connect(server, { plaintext: true }), error => error.code === '28000' && /no encryption/i.test(error.message));
  });
  assert(identity); await absent(identity);
});

for (const [leaf, code] of [['wrongName', 'ERR_TLS_CERT_ALTNAME_INVALID'], ['expired', 'CERT_HAS_EXPIRED'], ['future', 'CERT_NOT_YET_VALID']]) {
  test(`same trusted CA with ${leaf} leaf fails verification and cleans its exact server`, { timeout: 240_000 }, async () => {
    let identity;
    await withTlsTestServer({ leaf, onEvent: event => { if (event.type === 'ready') identity = event.identity; } }, async server => {
      await assert.rejects(connect(server), { code });
    });
    assert(identity); await absent(identity);
  });
}

test('cancellation at the ready boundary prevents the consumer from starting and removes the server', { timeout: 240_000 }, async () => {
  const controller = new AbortController();
  let identity, started = false;
  await assert.rejects(withTlsTestServer({ signal: controller.signal, onEvent: event => {
    if (event.type === 'ready') { identity = event.identity; controller.abort(new Error('cancelled at readiness')); }
  } }, async () => { started = true; }), /cancelled at readiness/);
  assert.equal(started, false);
  assert(identity); await absent(identity);
});
