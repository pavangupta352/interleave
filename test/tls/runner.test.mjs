import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import postgres from 'postgres';
import { withTlsTestServer } from '../../scripts/tls-test-server.mjs';

// CI selects postgres:16, 17 or 18; the owned TLS-only server uses the same official image.
const image = process.env.INTERLEAVE_TEST_POSTGRES_IMAGE ?? 'postgres:16';
import { tlsTestCommand } from '../../scripts/tls-test-command.mjs';
import { minimize, replay, runOnce, runScenarioFile } from '../../dist/index.js';

const execute = promisify(execFile);
const scenarioFile = fileURLToPath(new URL('./fixtures/counter.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const { default: counter } = await import(scenarioFile);

function url(server, host = server.connection.host) {
  const endpoint = new URL(`postgresql://${host}:${server.connection.port}/postgres`);
  endpoint.username = server.connection.user; endpoint.password = server.connection.password;
  return endpoint.toString();
}
function assertNoSecrets(value, server) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [server.connection.password, server.certificates.directory, 'BEGIN CERTIFICATE', 'PRIVATE KEY']) {
    assert(!text.includes(secret), 'harness output must not contain credentials, certificate material or private paths');
  }
}
// Local-socket trust inside the owned container: independent of the TLS path under test.
async function generatedDatabases(server) {
  const { stdout } = await tlsTestCommand('docker', ['exec', '--user', 'postgres', server.identity.id, 'psql', '-X', '-A', '-t', '-d', 'postgres',
    '-c', "SELECT datname FROM pg_database WHERE datname LIKE 'interleave\\_%'"], { timeout: 15_000 });
  return stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

test('records, replays and minimizes a real lost update with every connection on verified TLS', { timeout: 420_000 }, async () => {
  await withTlsTestServer({ image }, async server => {
    const upstreamTls = { mode: 'verify-full', ca: server.certificates.ca };
    const options = { databaseUrl: url(server), upstreamTls };
    const recorded = await runOnce(counter, options);
    assert.equal(recorded.outcome, 'violation', recorded.reason);
    assert.equal(recorded.schemaVersion, 3);
    assert.deepEqual(recorded.actors.map(actor => actor.value), [{ ssl: true }, { ssl: true }], 'each actor backend is encrypted');
    assert.deepEqual(recorded.environment.transport, {
      version: 1, frontend: 'loopback-plaintext-v1', authentication: 'passthrough-no-channel-binding-v1',
      upstream: { ...recorded.environment.transport.upstream, profile: 'tls-verify-full-v1', negotiation: 'postgres-sslrequest-v1',
        minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', trustSource: 'custom-ca' },
    });
    assert.equal(recorded.cleanup.complete, true);
    assertNoSecrets(recorded, server);

    const repeated = await replay(counter, recorded, options);
    assert.equal(repeated.outcome, 'violation', repeated.reason);
    assert.equal(repeated.failure.fingerprint, recorded.failure.fingerprint);

    // Changing TLS policy, trust or the verified name is a different execution, rejected before database work.
    for (const changed of [
      { databaseUrl: url(server) },
      { databaseUrl: url(server), upstreamTls: { mode: 'verify-full', ca: server.certificates.unrelatedCa } },
      { databaseUrl: url(server, 'localhost'), upstreamTls },
    ]) {
      const incompatible = await replay(counter, recorded, changed);
      assert.equal(incompatible.outcome, 'incompatible');
      assert.match(incompatible.reason, /transport/);
      assert.equal(incompatible.trace.length, 0);
      assert.equal(incompatible.environment.serverVersion, 'unknown');
    }

    const reduced = await minimize(counter, recorded, { ...options, maxAttempts: 20 });
    assert.equal(reduced.run.outcome, 'violation', reduced.run.reason);
    assert.equal(reduced.run.failure.fingerprint, recorded.failure.fingerprint);

    // Supervised file execution: the worker attaches with the parent's snapshot, not ambient settings.
    const supervised = await runScenarioFile(scenarioFile, options);
    assert.equal(supervised.outcome, 'violation', supervised.reason);
    assert.deepEqual(supervised.environment.transport, recorded.environment.transport);
    const supervisedReplay = await replay(scenarioFile, supervised, options);
    assert.equal(supervisedReplay.outcome, 'violation', supervisedReplay.reason);

    // DNS SAN: the URL name is sent as SNI and verified.
    const dns = await runOnce(counter, { databaseUrl: url(server, 'localhost'), upstreamTls });
    assert.equal(dns.outcome, 'violation', dns.reason);

    // Staged Describe/Flush cycles and Postgres.js parameter handling over the same verified upstream.
    const staged = await runOnce({
      name: 'tls-postgresjs',
      async setup({ db }) { await db.query('CREATE TABLE item (id integer PRIMARY KEY, n integer NOT NULL); INSERT INTO item VALUES (1, 41)'); },
      actors: Object.fromEntries(['alice', 'bob'].map(name => [name, async ({ connectionString }) => {
        const sql = postgres(connectionString, { max: 1, ssl: false, fetch_types: false, onnotice: () => {} });
        try {
          const [row] = await sql`SELECT n + ${1}::integer AS n, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl FROM item WHERE id = ${1}`;
          return { n: row.n, ssl: row.ssl };
        } finally { await sql.end({ timeout: 5 }); }
      }])),
      async invariant({ results }) { assert.deepEqual(results.map(result => result.value), [{ n: 42, ssl: true }, { n: 42, ssl: true }]); },
    }, { ...options, protocolProfile: 'describe-flush-v1' });
    assert.equal(staged.outcome, 'passed', staged.reason);
    assert.equal(staged.limits.protocolProfile, 'describe-flush-v1');
    assert(staged.trace.some(step => step.stage === 'describe'));

    // The CLI reads the CA file once and reports the enforced policy.
    const directory = await mkdtemp(join(tmpdir(), 'interleave-tls-cli-'));
    try {
      const caFile = join(directory, 'ca.pem');
      await writeFile(caFile, server.certificates.ca);
      const { stdout, stderr } = await execute(process.execPath, [cli, 'doctor', '--database-url', url(server), '--upstream-tls', '--upstream-ca', caFile], { timeout: 90_000 });
      assert.match(stdout, /Transport: verified TLS \(TLSv1\.2-TLSv1\.3, supplied CA bundle, hostname checked\)/);
      assertNoSecrets(stdout + stderr, server);
      await assert.rejects(execute(process.execPath, [cli, 'doctor', '--docker', '--upstream-tls'], { timeout: 30_000 }),
        error => error.code === 2 && /plaintext loopback server/.test(error.stderr));
    } finally { await rm(directory, { recursive: true, force: true }); }

    // Without TLS, the server's hostssl-only rules reject the administrator connection.
    const plaintext = await runOnce(counter, { databaseUrl: url(server) });
    assert.equal(plaintext.outcome, 'harness-error');
    assert.equal(plaintext.environment.transport.upstream.profile, 'plaintext-v1');
    assert.deepEqual(await generatedDatabases(server), []);
  });
});

test('an untrusted CA or a certificate for another name fails before any database is created', { timeout: 240_000 }, async () => {
  await withTlsTestServer({ image, leaf: 'wrongName' }, async server => {
    for (const [ca, reason] of [
      [server.certificates.unrelatedCa, /certificate|verif|issuer/i],
      [server.certificates.ca, /does not match the configured PostgreSQL hostname or IP address/],
    ]) {
      const failed = await runOnce(counter, { databaseUrl: url(server), upstreamTls: { mode: 'verify-full', ca } });
      assert.equal(failed.outcome, 'harness-error');
      assert.match(failed.reason, reason);
      assert.equal(failed.trace.length, 0);
      assert.equal(failed.cleanup.complete, true);
      assertNoSecrets(failed, server);
    }
    assert.deepEqual(await generatedDatabases(server), []);
  });
});
