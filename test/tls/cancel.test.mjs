import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { withTlsTestServer } from '../../scripts/tls-test-server.mjs';
import { replay, runOnce } from '../../dist/index.js';

// CI selects postgres:16, 17 or 18; the owned TLS-only server uses the same official image.
const image = process.env.INTERLEAVE_TEST_POSTGRES_IMAGE ?? 'postgres:16';
function url(server) {
  const endpoint = new URL(`postgresql://${server.connection.host}:${server.connection.port}/postgres`);
  endpoint.username = server.connection.user; endpoint.password = server.connection.password;
  return endpoint.toString();
}
const scenario = {
  name: 'tls-cancel',
  async setup() {},
  actors: {
    async alice({ connectionString }) {
      const client = new pg.Client({ connectionString }); client.on('error', () => {}); await client.connect();
      try {
        const query = client.query(new pg.Query('SELECT pg_sleep(30)'));
        const settled = new Promise(resolve => { query.once('error', error => resolve(error.code)); query.once('end', () => resolve('completed')); });
        // node-postgres sends the request on a new plaintext loopback connection to the actor endpoint.
        const timer = setTimeout(() => new pg.Client({ connectionString }).cancel(client, query), 300);
        try { return await settled; } finally { clearTimeout(timer); }
      } finally { await client.end(); }
    },
    async bob() {},
  },
  async invariant({ results }) { assert.equal(results.find(result => result.actor === 'alice')?.value, '57014'); },
};

test('forwards a cancel request to PostgreSQL over verified TLS and replays it', { timeout: 240_000 }, async () => {
  await withTlsTestServer({ image }, async server => {
    const options = { databaseUrl: url(server), upstreamTls: { mode: 'verify-full', ca: server.certificates.ca } };
    const recorded = await runOnce(scenario, options);
    assert.equal(recorded.outcome, 'passed', recorded.reason);
    assert.equal(recorded.cleanup.complete, true);
    assert.equal(recorded.schemaVersion, 5);
    assert.equal(recorded.environment.transport.upstream.profile, 'tls-verify-full-v1');
    const step = recorded.trace.findIndex(candidate => candidate.sql === 'SELECT pg_sleep(30)');
    assert.equal(recorded.trace[step].completion.error.code, '57014');
    assert.deepEqual(recorded.cancels.map(({ at: _at, backendPid: _pid, ...rest }) => rest), [{ actor: 'alice', forwarded: true, connection: 0, step }]);
    const repeated = await replay(scenario, recorded, options);
    assert.equal(repeated.outcome, 'passed', repeated.reason);
    assert.equal(repeated.cancels[0].step, step);
  });
});
