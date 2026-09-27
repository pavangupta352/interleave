import assert from 'node:assert/strict';
import pg from 'pg';
import test from 'node:test';
import { withTlsTestServer } from '../../scripts/tls-test-server.mjs';

// CI selects postgres:16, 17 or 18; the owned TLS-only server uses the same official image.
const image = process.env.INTERLEAVE_TEST_POSTGRES_IMAGE ?? 'postgres:16';
import { createOwnedDatabase } from '../../dist/database.js';
import { attachOwnedDatabase } from '../../dist/attached-database.js';
import { captureFixtureIdentity } from '../../dist/fixture-identity.js';
import { postgresClientConfig, resolvePostgresTransport } from '../../dist/postgres-transport.js';

function url(server) {
  const endpoint = new URL(`postgresql://${server.connection.host}:${server.connection.port}/postgres`);
  endpoint.username = server.connection.user; endpoint.password = server.connection.password;
  return endpoint.toString();
}
test('every owned direct database connection verifies a private CA through create, attachment, capture and cleanup', { timeout: 120_000 }, async () => {
  await withTlsTestServer({ image }, async server => {
    const transport = resolvePostgresTransport(url(server), { mode: 'verify-full', ca: server.certificates.ca });
    const rows = [], original = pg.Client.prototype.connect;
    pg.Client.prototype.connect = async function (...args) {
      assert.equal(args.length, 0);
      await original.call(this);
      const observed = await this.query('SELECT current_database() AS database, ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
      rows.push(observed.rows[0]);
    };
    let database, attached;
    try {
      database = await createOwnedDatabase(transport.connectionString, transport);
      await database.db.query('CREATE TABLE counter(id integer PRIMARY KEY, value integer); INSERT INTO counter VALUES (1,0)');
      attached = await attachOwnedDatabase(database.connectionString, database.transport);
      const extra = new pg.Client(database.connectionOptions);
      try { await extra.connect(); assert.equal((await extra.query('SELECT value FROM counter')).rows[0].value, 0); }
      finally { await extra.end(); }
      const fixture = await captureFixtureIdentity(database.connectionString, { transport: database.transport });
      assert.match(fixture.fingerprint, /^[a-f0-9]{64}$/);
      await attached.close(); attached = undefined;
      await database.close();
      const admin = new pg.Client(postgresClientConfig(transport));
      try {
        await admin.connect();
        assert.deepEqual((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [database.name])).rows, []);
      } finally { await admin.end(); }
      assert.equal(rows.filter(row => row.database === database.name).length, 6, 'setup, observer, two worker clients, extra context client and fixture capture');
      assert.equal(rows.filter(row => row.database === 'postgres').length, 3, 'creation, cleanup and independent absence administrator');
      assert(rows.every(row => row.ssl === true && /^TLSv1\.[23]$/.test(row.version)));
    } finally {
      await attached?.close(); await database?.close(); pg.Client.prototype.connect = original;
    }
  });
});
