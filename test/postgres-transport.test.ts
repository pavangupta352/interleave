import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rootCertificates, type ConnectionOptions } from 'node:tls';
import { inspect } from 'node:util';

import { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  postgresClientConfig,
  postgresTlsOptions,
  resolvePostgresTransport,
  restorePostgresTransport,
  type UpstreamTlsInput,
} from '../src/postgres-transport.js';

const url = 'postgresql://fixture-user:credential-sentinel@DB.Fixture.Test/fixture';
const ca = rootCertificates[0]!;
const otherCa = rootCertificates[1]!;
// Generated for this repository; only its public certificate is retained.
const leaf = new X509Certificate(readFileSync(new URL('./fixtures/tls/reference-name.pem', import.meta.url)));
const tlsInput = { mode: 'verify-full', ca } as const;

function expectCode(action: () => unknown, code: string): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code });
}

afterEach(() => vi.unstubAllEnvs());

describe('closed PostgreSQL transport selection', () => {
  it('pins the authority and plaintext policy while preserving startup settings', () => {
    const resolved = resolvePostgresTransport(`${url}?sslmode=disable&options=-c%20search_path%3Dpublic&application_name=fixture&database=discard`);
    const client = new Client(postgresClientConfig(resolved));
    expect(client.host).toBe('db.fixture.test');
    expect(client.port).toBe(5432);
    expect(client.database).toBe('fixture');
    expect(client.ssl).toBe(false);
    expect(resolved.identity).toEqual({ profile: 'plaintext-v1' });
    const canonical = new URL(resolved.connectionString);
    expect(canonical.searchParams.has('sslmode')).toBe(false);
    expect(canonical.searchParams.has('database')).toBe(false);
    expect(canonical.searchParams.get('options')).toBe('-c search_path=public');
    expect(canonical.searchParams.get('application_name')).toBe('fixture');
    expect(postgresClientConfig(resolved)).toMatchObject({ options: '-c search_path=public', application_name: 'fixture' });
  });

  it('resolves the URL-only verified selector against explicit Node bundled roots', () => {
    const resolved = resolvePostgresTransport(`${url}?sslmode=verify-full`);
    expect(resolved.identity).toMatchObject({
      profile: 'tls-verify-full-v1', trustSource: 'node-bundled',
      negotiation: 'postgres-sslrequest-v1', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
    });
    expect(resolved.caCertificates.length).toBeGreaterThan(64);
    expect(resolved.caCertificates).toContain(new X509Certificate(ca).toString());
    expect(new URL(resolved.connectionString).searchParams.has('sslmode')).toBe(false);
  });

  it.each(['require', 'allow', 'prefer', 'verify-ca', 'no-verify', 'true', ''])('rejects ambiguous sslmode=%s', mode => {
    expectCode(() => resolvePostgresTransport(`${url}?sslmode=${mode}`), 'unsupported-url-option');
  });

  it.each([
    'ssl=true', 'ssl=0', 'sslrootcert=%2Fprivate%2Fca-sentinel.pem', 'sslcert=certificate-sentinel',
    'sslkey=key-sentinel', 'sslnegotiation=direct', 'sslnegotiation=postgres', 'uselibpqcompat=true',
    'sslpassword=credential-sentinel', 'SSLMode=verify-full', 'channel_binding=require',
    'enableChannelBinding=true', 'host=other.fixture.test', 'hostaddr=127.0.0.2', 'port=9000',
    'user=other', 'password=credential-sentinel',
    'connectionString=postgres%3A%2F%2Fother%2Fdb', 'stream=sentinel', 'unknown=sentinel',
  ])('rejects unsupported URL configuration %s before pg sees it', query => {
    expectCode(() => resolvePostgresTransport(`${url}?${query}`), 'unsupported-url-option');
  });

  it('rejects duplicate TLS selectors even when identical', () => {
    expectCode(() => resolvePostgresTransport(`${url}?sslmode=verify-full&sslmode=verify-full`), 'unsupported-url-option');
  });

  it.each(['verify-full', 'disable'])('rejects competing URL and structured TLS selections (%s)', mode => {
    expectCode(() => resolvePostgresTransport(`${url}?sslmode=${mode}`, tlsInput), 'conflicting-tls-options');
  });

  it.each([
    null, true, [], { mode: 'require' }, { ca }, { mode: 'verify-full', ca: undefined },
    { mode: 'verify-full', ca: 1 }, { mode: 'verify-full', rejectUnauthorized: false },
    { mode: 'verify-full', servername: 'other.fixture.test' }, { mode: 'verify-full', cert: 'sentinel' },
    { mode: 'verify-full', key: 'sentinel' }, { mode: 'verify-full', checkServerIdentity: () => undefined },
    { mode: 'verify-full', enableChannelBinding: true },
  ])('rejects non-profile structured configuration %#', input => {
    expectCode(() => resolvePostgresTransport(url, input as UpstreamTlsInput), 'invalid-tls-options');
  });

  it('rejects hidden structured configuration keys', () => {
    const hidden = Object.defineProperty({ mode: 'verify-full' }, 'servername', { value: 'other.fixture.test' });
    expectCode(() => resolvePostgresTransport(url, hidden as UpstreamTlsInput), 'invalid-tls-options');
  });

  it('rejects throwing configuration access without exposing its contents', () => {
    const throwing = new Proxy({}, { getPrototypeOf() { throw new Error('credential-sentinel'); } });
    expectCode(() => resolvePostgresTransport(url, throwing as UpstreamTlsInput), 'invalid-tls-options');
  });

  it('bounds the canonical URL after percent encoding expands credential bytes', () => {
    expectCode(() => resolvePostgresTransport(`postgres://user:${'ü'.repeat(6_000)}@db.fixture.test/fixture`), 'invalid-url');
  });

  it.each([
    '', 'https://fixture-user:credential-sentinel@db.fixture.test/fixture', 'postgresql:///fixture',
    'postgresql://db.fixture.test', 'postgresql://db.fixture.test/', 'postgresql://db.fixture.test:0/fixture',
    'postgresql://db.fixture.test:65536/fixture', 'postgresql://%2Fprivate%2Fsocket/fixture',
    'postgresql://db.fixture.test/fixture#credential-sentinel', 'postgresql://db.fixture.test/%00',
    'postgresql://db.fixture.test/fixture?options=' + 'x'.repeat(16_384),
  ])('rejects invalid or unbounded connection authority %#', input => {
    expectCode(() => resolvePostgresTransport(input), 'invalid-url');
  });

  it.each([
    ['DB.Fixture.Test.', 'db.fixture.test'], ['bücher.test', 'xn--bcher-kva.test'],
    ['127.000.000.001', '127.0.0.1'], ['[0:0:0:0:0:0:0:1]', '::1'],
  ])('normalizes reference %s without choosing a different verification name', (host, expected) => {
    const resolved = resolvePostgresTransport(`postgres://user:pass@${host}:5433/fixture`, tlsInput);
    expect(resolved.hostname).toBe(expected);
    const client = new Client(postgresClientConfig(resolved));
    expect(client.host).toBe(expected);
    expect(client.port).toBe(5433);
  });
});

describe('bounded canonical trust snapshots', () => {
  it('replaces default trust with the custom CA and canonicalizes PEM order, whitespace and duplicates', () => {
    const one = resolvePostgresTransport(url, { mode: 'verify-full', ca: `${ca}\n${otherCa}` });
    const two = resolvePostgresTransport(url, { mode: 'verify-full', ca: `\r\n${otherCa.replaceAll('\n', '\r\n')}\n${ca}\n${ca}\n` });
    expect(one.caCertificates).toHaveLength(2);
    expect(one.caCertificates).toEqual(two.caCertificates);
    expect(one.identity).toEqual(two.identity);
    expect(one.identity).toMatchObject({ trustSource: 'custom-ca' });
    expect(resolvePostgresTransport(url, tlsInput).caCertificates).toEqual([new X509Certificate(ca).toString()]);
  });

  it('binds trust and the normalized reference independently of port, database and credentials', () => {
    const first = resolvePostgresTransport(url, tlsInput);
    const moved = resolvePostgresTransport('postgres://other:other@db.fixture.test:6432/other', tlsInput);
    expect(first.identity).toEqual(moved.identity);
    expect(resolvePostgresTransport(url, { mode: 'verify-full', ca: otherCa }).identity).not.toEqual(first.identity);
    expect(resolvePostgresTransport('postgres://user:pass@other.fixture.test/fixture', tlsInput).identity).not.toEqual(first.identity);
    const identity = JSON.stringify(first.identity);
    for (const secret of ['credential-sentinel', 'db.fixture.test', 'BEGIN CERTIFICATE', ca]) expect(identity).not.toContain(secret);
  });

  it.each(['', 'not PEM', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
    `${ca}\n-----BEGIN PRIVATE KEY-----\nkey-sentinel\n-----END PRIVATE KEY-----`,
    `${ca}\ntrailing-sentinel`, leaf.toString(), ca.replace('MI', '!I'),
  ])('rejects malformed, mixed or non-CA material %#', material => {
    expectCode(() => resolvePostgresTransport(url, { mode: 'verify-full', ca: material }), 'invalid-ca');
  });

  it('bounds the original CA input and certificate count before deduplication', () => {
    expectCode(() => resolvePostgresTransport(url, { mode: 'verify-full', ca: ' '.repeat(1_048_577) }), 'ca-too-large');
    expectCode(() => resolvePostgresTransport(url, { mode: 'verify-full', ca: ca.repeat(65) }), 'ca-too-large');
    expect(resolvePostgresTransport(url, { mode: 'verify-full', ca: ca.repeat(64) }).caCertificates).toHaveLength(1);
  });

  it('freezes the entire serializable snapshot and restores equivalent trusted data', () => {
    const resolved = resolvePostgresTransport(url, tlsInput);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.identity)).toBe(true);
    expect(Object.isFrozen(resolved.caCertificates)).toBe(true);
    expect(() => (resolved.caCertificates as string[]).push(otherCa)).toThrow();
    const copy = restorePostgresTransport(JSON.parse(JSON.stringify(resolved)));
    expect(copy).toEqual(resolved);
    expect(copy).not.toBe(resolved);
    expect(postgresTlsOptions(copy)?.rejectUnauthorized).toBe(true);
    expect(restorePostgresTransport(JSON.parse(JSON.stringify(resolvePostgresTransport(url))))).toEqual(resolvePostgresTransport(url));
    expect(restorePostgresTransport(JSON.parse(JSON.stringify(resolvePostgresTransport(url, { mode: 'verify-full' }))))).toEqual(resolvePostgresTransport(url, { mode: 'verify-full' }));
  });

  it.each(['hostname', 'port', 'connectionString', 'caCertificates', 'identity', 'extra', 'version'])('rejects forged serialized snapshot field %s', field => {
    const copy = JSON.parse(JSON.stringify(resolvePostgresTransport(url, tlsInput))) as Record<string, unknown>;
    copy[field] = field === 'caCertificates' ? [otherCa] : field === 'port' ? 6432 : 'credential-sentinel';
    expectCode(() => restorePostgresTransport(copy), 'invalid-snapshot');
  });

  it('rejects weakened policy and false bundled-root provenance in serialized data', () => {
    const copy = JSON.parse(JSON.stringify(resolvePostgresTransport(url, tlsInput)));
    copy.identity.trustSource = 'node-bundled';
    expectCode(() => restorePostgresTransport(copy), 'invalid-snapshot');
    copy.identity.trustSource = 'custom-ca';
    copy.identity.minVersion = 'TLSv1';
    expectCode(() => restorePostgresTransport(copy), 'invalid-snapshot');
  });

  it('rejects hidden snapshot keys', () => {
    const copy = JSON.parse(JSON.stringify(resolvePostgresTransport(url, tlsInput)));
    Object.defineProperty(copy, 'extra', { value: 'credential-sentinel' });
    expectCode(() => restorePostgresTransport(copy), 'invalid-snapshot');
  });

  it('rejects non-JSON array extensions', () => {
    const arrayCopy = JSON.parse(JSON.stringify(resolvePostgresTransport(url, tlsInput)));
    arrayCopy.caCertificates.extra = 'credential-sentinel';
    expectCode(() => restorePostgresTransport(arrayCopy), 'invalid-snapshot');
  });

  it('validates deserialized snapshots again at both live configuration boundaries', () => {
    const copy = JSON.parse(JSON.stringify(resolvePostgresTransport(url, tlsInput)));
    copy.identity.trustFingerprint = '0'.repeat(64);
    expectCode(() => postgresClientConfig(copy), 'invalid-snapshot');
    expectCode(() => postgresTlsOptions(copy), 'invalid-snapshot');
  });
});

describe('strict live configuration without network access', () => {
  it('overrides ambient pg routing and TLS choices in actual installed Client configuration', () => {
    vi.stubEnv('PGHOST', 'other.fixture.test');
    vi.stubEnv('PGPORT', '6432');
    vi.stubEnv('PGDATABASE', 'other');
    vi.stubEnv('PGSSLMODE', 'no-verify');
    vi.stubEnv('PGSSLNEGOTIATION', 'direct');
    vi.stubEnv('PGSSLROOTCERT', '/private/ca-sentinel.pem');
    vi.stubEnv('PGSSLCERT', '/private/cert-sentinel.pem');
    vi.stubEnv('PGSSLKEY', '/private/key-sentinel.pem');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/private/extra-sentinel.pem');
    for (const input of [undefined, tlsInput]) {
      const config = postgresClientConfig(resolvePostgresTransport(url, input));
      const client = new Client(config);
      expect(client.host).toBe('db.fixture.test');
      expect(client.port).toBe(5432);
      expect(client.database).toBe('fixture');
      expect(config.sslnegotiation).toBe('postgres');
      expect(config.enableChannelBinding).toBe(false);
      // This installed-driver boundary matters: URL parsing can replace config.ssl.
      expect(client.ssl).toEqual(input === undefined ? false : expect.objectContaining({
        rejectUnauthorized: true, ca: [new X509Certificate(ca).toString()],
      }));
      expect((client as unknown as { connectionParameters: { sslnegotiation: string } }).connectionParameters.sslnegotiation).toBe('postgres');
    }
    const bundled = resolvePostgresTransport(url, { mode: 'verify-full' });
    expect(bundled.caCertificates).toHaveLength(new Set(rootCertificates.map(pem => new X509Certificate(pem).fingerprint256)).size);
  });

  it('constructs fresh driver options so one consumer cannot mutate retained trust or another consumer', () => {
    const resolved = resolvePostgresTransport(url, tlsInput);
    const first = postgresClientConfig(resolved).ssl as ConnectionOptions;
    const second = postgresClientConfig(resolved).ssl as ConnectionOptions;
    expect(first).not.toBe(second);
    expect(first.checkServerIdentity).not.toBe(second.checkServerIdentity);
    (first.ca as string[]).push(otherCa);
    first.rejectUnauthorized = false;
    expect(second.ca).toEqual([new X509Certificate(ca).toString()]);
    expect(second.rejectUnauthorized).toBe(true);
    expect(resolved.caCertificates).toHaveLength(1);
  });

  it.each([
    ['db.fixture.test', true, 'db.fixture.test'], ['other.fixture.test', false, 'other.fixture.test'],
    ['one.wildcard.fixture.test', true, 'one.wildcard.fixture.test'],
    ['two.one.wildcard.fixture.test', false, 'two.one.wildcard.fixture.test'],
    ['unused-common-name.fixture.test', false, 'unused-common-name.fixture.test'],
    ['127.0.0.1', true, undefined], ['127.0.0.2', false, undefined], ['[::1]', true, undefined],
  ])('verifies URL reference %s using real DNS/IP SANs and correct SNI', (host, matches, sni) => {
    const options = postgresTlsOptions(resolvePostgresTransport(`postgres://user:pass@${host}/fixture`, tlsInput))!;
    expect(options.servername).toBe(sni);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.minVersion).toBe('TLSv1.2');
    expect(options.maxVersion).toBe('TLSv1.3');
    // Ignore a caller-supplied alternate reference; URL identity is authoritative.
    const failure = options.checkServerIdentity!('db.fixture.test', leaf.toLegacyObject());
    if (matches) expect(failure).toBeUndefined();
    else {
      expect(failure).toMatchObject({ code: 'certificate-name-mismatch' });
      for (const secret of ['fixture.test', 'BEGIN CERTIFICATE', 'subjectaltname', 'credential-sentinel']) {
        expect(inspect(failure)).not.toContain(secret);
      }
    }
  });

  it('returns no TLS options for the explicit plaintext profile', () => {
    expect(postgresTlsOptions(resolvePostgresTransport(url))).toBeUndefined();
  });

  it('preserves missing-credential driver defaults without letting explicit credentials drift', () => {
    vi.stubEnv('PGUSER', 'ambient-user');
    vi.stubEnv('PGPASSWORD', 'ambient-password');
    const implicit = new Client(postgresClientConfig(resolvePostgresTransport('postgres://db.fixture.test/fixture')));
    expect(implicit.user).toBe('ambient-user');
    expect(implicit.password).toBe('ambient-password');
    const explicit = new Client(postgresClientConfig(resolvePostgresTransport(url)));
    expect(explicit.user).toBe('fixture-user');
    expect(explicit.password).toBe('credential-sentinel');
  });

  it('never attaches untrusted URL, certificate or path material to configuration errors', () => {
    for (const action of [
      () => resolvePostgresTransport('credential-sentinel'),
      () => resolvePostgresTransport(`${url}?sslrootcert=/private/ca-sentinel.pem`),
      () => resolvePostgresTransport(url, { mode: 'verify-full', ca: `${ca}key-sentinel` }),
    ]) {
      let caught: unknown;
      try { action(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      for (const secret of ['credential-sentinel', 'key-sentinel', 'ca-sentinel', '/private', 'BEGIN CERTIFICATE']) {
        expect(inspect(caught)).not.toContain(secret);
        expect(JSON.stringify(caught)).not.toContain(secret);
      }
    }
  });
});
