import assert from 'node:assert/strict';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import test from 'node:test';
import { withTlsTestCertificates } from '../../scripts/tls-test-certificates.mjs';

test('generated leaves distinguish trust, DNS/IP names and deliberate validity windows', async () => {
  let directory;
  await withTlsTestCertificates(async material => {
    directory = material.directory;
    assert.match(material.opensslVersion, /^OpenSSL 3\./);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const ca = new X509Certificate(material.ca), unrelated = new X509Certificate(material.unrelatedCa);
    assert.equal(ca.ca, true);
    for (const leaf of Object.values(material.leaves)) {
      const cert = new X509Certificate(leaf.cert);
      assert.equal(cert.ca, false);
      assert.equal(cert.verify(ca.publicKey), true, 'Every negative leaf must retain the same trusted issuer');
      assert.equal(cert.verify(unrelated.publicKey), false);
      assert.equal(cert.checkPrivateKey(createPrivateKey(await readFile(leaf.keyPath))), true);
      assert.equal((await stat(leaf.keyPath)).mode & 0o777, 0o600);
      assert.equal(await readFile(leaf.certPath, 'utf8'), leaf.cert);
    }
    const valid = new X509Certificate(material.leaves.valid.cert);
    assert.equal(checkServerIdentity('localhost', valid.toLegacyObject()), undefined);
    assert.equal(checkServerIdentity('127.0.0.1', valid.toLegacyObject()), undefined);
    assert.equal(checkServerIdentity('different.invalid', valid.toLegacyObject())?.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    const wrong = new X509Certificate(material.leaves.wrongName.cert);
    assert.equal(checkServerIdentity('localhost', wrong.toLegacyObject())?.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(checkServerIdentity('127.0.0.1', wrong.toLegacyObject())?.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    const now = Date.now(), expired = new X509Certificate(material.leaves.expired.cert), future = new X509Certificate(material.leaves.future.cert);
    assert(Date.parse(valid.validFrom) <= now && Date.parse(valid.validTo) > now);
    assert(Date.parse(expired.validTo) < now - 3_600_000);
    assert(Date.parse(future.validFrom) > now + 3_600_000);
  });
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('private keys and the owned directory are removed when a consumer fails', async () => {
  let directory;
  await assert.rejects(withTlsTestCertificates(async material => {
    directory = material.directory;
    assert.equal((await stat(material.leaves.valid.keyPath)).isFile(), true);
    throw new Error('deliberate fixture consumer failure');
  }), /deliberate fixture consumer failure/);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('an unavailable certificate executable fails and removes its exact temporary directory', async () => {
  let directory;
  await assert.rejects(withTlsTestCertificates(() => assert.fail('consumer must not start'), {
    openssl: '/interleave-owned-fixture-tool-does-not-exist',
    onDirectory: path => { directory = path; },
  }), /OpenSSL/);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
