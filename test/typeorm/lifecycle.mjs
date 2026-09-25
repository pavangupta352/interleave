import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createOwnedDatabase } from '../../dist/database.js';
import { createProxy } from '../../dist/proxy.js';
import { runOnce } from '../../dist/runner.js';
import { runScenarioFile } from '../../dist/supervised.js';
import { parseRunArtifact } from '../../dist/artifact.js';

assert.equal(process.version, 'v22.18.0', 'This separate TypeORM qualification requires Node22.18.0; it must not silently skip');
const require = createRequire(new URL('../../examples/typeorm/package.json', import.meta.url));
const pg = require('pg');
assert.equal(require('pg/package.json').version, '8.23.0');
assert.equal(JSON.parse(await readFile(new URL('../../examples/typeorm/node_modules/typeorm/package.json', import.meta.url))).version, '1.1.1');
const databaseUrl = process.env.TEST_DATABASE_URL;
assert(databaseUrl, 'TEST_DATABASE_URL must identify an explicit dedicated PostgreSQL administrator database');
const helperUrl = process.env.INTERLEAVE_TYPEORM_BASELINE
  ? pathToFileURL(process.env.INTERLEAVE_TYPEORM_BASELINE)
  : new URL('../../examples/typeorm/connection.mjs', import.meta.url);
const { withTypeOrmActor } = await import(helperUrl.href);
const journal = async record => {
  if (process.env.INTERLEAVE_TYPEORM_JOURNAL) await appendFile(process.env.INTERLEAVE_TYPEORM_JOURNAL, JSON.stringify(record) + '\n');
};
async function until(check, label, timeout = 3000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { const value = await check(); if (value) return value; await pause(10); }
  assert.fail(label);
}
function observed(promise) {
  const state = { settled: false };
  state.promise = promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
async function owned(use) {
  const database = await createOwnedDatabase(databaseUrl);
  try { return await use(database); }
  finally {
    await database.close();
    const admin = new pg.Client({ connectionString: databaseUrl });
    try {
      await admin.connect();
      const databases = (await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [database.name])).rows;
      const backends = (await admin.query('SELECT pid FROM pg_stat_activity WHERE datname = $1', [database.name])).rows;
      await journal({ event: 'database-cleanup', name: database.name, databases, backends });
      assert.deepEqual(databases, []); assert.deepEqual(backends, []);
    } finally { await admin.end(); }
  }
}
// These observers forward the actual public methods unchanged. They establish
// that helper settlement includes Pool.end, beyond mere backend disappearance.
async function observedPools(use) {
  const connect = pg.Pool.prototype.connect, end = pg.Pool.prototype.end;
  const pools = new Set(), ended = new Set();
  pg.Pool.prototype.connect = function (...args) { pools.add(this); return connect.apply(this, args); };
  pg.Pool.prototype.end = function (callback) {
    if (callback) return end.call(this, error => { if (!error) ended.add(this); callback(error); });
    return end.call(this).then(value => { ended.add(this); return value; });
  };
  try {
    await use(pools);
    assert(pools.size > 0, 'The real TypeORM driver must construct and acquire a pg Pool');
    assert.equal(ended.size, pools.size, 'Every created pg Pool must finish ending before the helper settles');
  } finally {
    await journal({ event: 'pool-cleanup', created: pools.size, ended: ended.size,
      counts: [...pools].map(pool => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount })) });
    pg.Pool.prototype.connect = connect; pg.Pool.prototype.end = end;
  }
}
async function noActorBackend(database) {
  await until(async () => (await database.db.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'interleave-typeorm'")).rowCount === 0,
    'The helper must close its actor backend before test-owned database/proxy cleanup');
}

test('normal completion returns real rows and ends the actor pool', { concurrency: false }, () => observedPools(() => owned(async database => {
  const value = await withTypeOrmActor({ connectionString: database.connectionString, signal: new AbortController().signal }, [],
    runner => runner.query('SELECT $1::int AS value', [7]));
  assert.deepEqual(value, [{ value: 7 }]); await noActorBackend(database);
})));

test('an undefined operation rejection remains rejected after real initialization and cleanup', { concurrency: false }, () => observedPools(() => owned(async database => {
  const result = await withTypeOrmActor({ connectionString: database.connectionString, signal: new AbortController().signal }, [],
    async runner => { await runner.query('SELECT 1'); throw undefined; })
    .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
  assert.deepEqual(result, { status: 'rejected', error: undefined });
  await noActorBackend(database);
})));

for (const interruption of ['cancel', 'deadline']) test(`in-process ${interruption} records cooperative actor outcomes and owned database cleanup`, { concurrency: false }, async () => {
  const controller = new AbortController(), names = [];
  const scenario = {
    name: 'typeorm-in-process-lifecycle',
    async setup({ connectionString }) { names.push(new URL(connectionString).pathname.slice(1)); },
    actors: {
      alice: context => withTypeOrmActor(context, [], runner => runner.query('SELECT 42 AS marker')),
      async bob({ signal }) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    },
    invariant() { assert.fail('An interrupted run must not evaluate the invariant'); },
  };
  const running = runOnce(scenario, { databaseUrl, signal: controller.signal, timeoutMs: interruption === 'deadline' ? 1500 : 10000 });
  const admin = new pg.Client({ connectionString: databaseUrl });
  try {
    await admin.connect();
    await until(async () => (await admin.query("SELECT pid FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND application_name = 'interleave-typeorm'", [names])).rowCount > 0,
      'A real TypeORM actor backend must be present before interruption');
    if (interruption === 'cancel') controller.abort();
    const run = await running;
    assert.equal(run.outcome, 'inconclusive', run.reason); assert.match(run.reason, interruption === 'cancel' ? /cancel/i : /deadline/i);
    assert.deepEqual(run.actors.map(actor => [actor.actor, actor.status]), [['alice', 'rejected'], ['bob', 'fulfilled']]);
    assert.equal(run.cleanup.complete, true); assert.deepEqual(parseRunArtifact(run), run);
    const databases = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names])).rows;
    const backends = (await admin.query('SELECT pid FROM pg_stat_activity WHERE datname = ANY($1::text[])', [names])).rows;
    assert.deepEqual(databases, []); assert.deepEqual(backends, []);
    await journal({ event: 'in-process', interruption, names, databases, backends, run });
  } finally { controller.abort(); const run = await running; await journal({ event: 'in-process-final', interruption, names, run }); await admin.end(); }
});

test('source-bound supervised cancellation contains the installed TypeORM actor', { concurrency: false }, async () => {
  const directory = process.env.INTERLEAVE_TYPEORM_RUN_DIRECTORY
    ? join(process.env.INTERLEAVE_TYPEORM_RUN_DIRECTORY, 'source-bound-consumer')
    : await mkdtemp(join(tmpdir(), 'interleave-typeorm-lifecycle-'));
  await mkdir(directory, { recursive: true });
  // Retain a complete copy of the exact installation; no symlinked dependency
  // tree or fabricated identity. The original example install stays unchanged.
  await cp(new URL('../../examples/typeorm/', import.meta.url), directory, { recursive: true });
  await cp(new URL('./queued-scenario.mjs', import.meta.url), join(directory, 'scenario.mjs'));
  const namesFile = join(directory, 'owned-databases.txt'); await writeFile(namesFile, '');
  const previous = process.env.INTERLEAVE_TYPEORM_NAMES;
  process.env.INTERLEAVE_TYPEORM_NAMES = namesFile;
  const controller = new AbortController(), admin = new pg.Client({ connectionString: databaseUrl });
  const running = runScenarioFile(join(directory, 'scenario.mjs'), { databaseUrl, signal: controller.signal,
    timeoutMs: 20000, source: { projectRoot: directory } });
  try {
    await admin.connect();
    const names = await until(async () => {
      const owned = (await readFile(namesFile, 'utf8')).trim().split('\n').filter(Boolean);
      const rows = (await admin.query("SELECT pid FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND application_name = 'interleave-typeorm'", [owned])).rows;
      return rows.length ? owned : undefined;
    }, 'Source-bound worker must reach a real TypeORM backend before cancellation', 12000);
    controller.abort();
    const run = await running;
    assert.equal(run.outcome, 'inconclusive', run.reason); assert.match(run.reason, /cancel/i); assert.equal(run.cleanup.complete, true);
    assert(run.environment.source.components.dependencies.packages.some(node => node.name === 'typeorm' && node.version === '1.1.1'));
    assert.deepEqual(parseRunArtifact(run), run);
    const databases = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names])).rows;
    const backends = (await admin.query('SELECT pid FROM pg_stat_activity WHERE datname = ANY($1::text[])', [names])).rows;
    assert.deepEqual(databases, []); assert.deepEqual(backends, []);
    await journal({ event: 'supervised', directory, names, databases, backends, run });
  } finally {
    controller.abort(); await running; await admin.end();
    if (previous === undefined) delete process.env.INTERLEAVE_TYPEORM_NAMES; else process.env.INTERLEAVE_TYPEORM_NAMES = previous;
  }
});

test('SQL failure preserves the real 23505 code and closes the pool', { concurrency: false }, () => observedPools(() => owned(async database => {
  await database.db.query('CREATE TABLE counter (id integer PRIMARY KEY, value integer); INSERT INTO counter VALUES (1, 0)');
  await assert.rejects(withTypeOrmActor({ connectionString: database.connectionString, signal: new AbortController().signal }, [],
    runner => runner.query('INSERT INTO counter VALUES ($1, $2)', [1, 2])), error => error.driverError?.code === '23505');
  await noActorBackend(database);
})));

test('checked-out client failure cannot become a successful operation result', { concurrency: false }, () => observedPools(() => owned(async database => {
  let ready, resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  const running = observed(withTypeOrmActor({ connectionString: database.connectionString, signal: new AbortController().signal }, [], async runner => {
    const result = await runner.query('SELECT pg_backend_pid() AS pid'); ready = result[0].pid;
    await waiting; return 'unexpected success';
  }));
  try {
    await until(() => ready, 'The actor must obtain a real checked-out backend');
    await database.db.query('SELECT pg_terminate_backend($1)', [ready]);
    await until(async () => !(await database.db.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [ready])).rowCount,
      'The owned actor backend must actually terminate');
    await pause(30); resume(); await running.promise;
    assert(running.error, 'A real checked-out client error must reject the operation');
    await journal({ event: 'checked-out-error', code: running.error.code, message: running.error.message });
  } finally { resume(); await running.promise; }
})));

for (const interruption of ['cancel', 'deadline']) test(`${interruption} settles a real blocked query before the blocker is released`, { concurrency: false }, () => observedPools(() => owned(async database => {
  await database.db.query('CREATE TABLE counter (id integer PRIMARY KEY, value integer); INSERT INTO counter VALUES (1, 0)');
  const blocker = new pg.Client({ connectionString: database.connectionString });
  const controller = new AbortController();
  let running, timer;
  try {
    await blocker.connect(); await blocker.query('BEGIN'); await blocker.query('UPDATE counter SET value = 3 WHERE id = 1');
    running = observed(withTypeOrmActor({ connectionString: database.connectionString, signal: controller.signal }, [],
      runner => runner.query('UPDATE counter SET value = $1 WHERE id = $2 RETURNING value', [9, 1])));
    const row = await until(async () => (await database.db.query("SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'interleave-typeorm' AND wait_event_type = 'Lock'")).rows[0], 'A real PostgreSQL lock wait must precede interruption');
    assert(row.blockers.length > 0);
    await journal({ event: 'blocked', interruption, row });
    const reason = new Error(interruption === 'deadline' ? 'Actor deadline expired' : 'Actor cancelled');
    if (interruption === 'deadline') timer = setTimeout(() => controller.abort(reason), 30);
    else controller.abort(reason);
    await until(() => running.settled, 'Actor query must reject after cancellation while the blocker remains held', 500);
    assert(running.error, 'Cancellation must not turn a pending update into a fulfilled operation');
    // Closing a client is not PostgreSQL's separate CancelRequest protocol.
    // A backend blocked in the server can remain until owned DB containment.
    const remaining = (await database.db.query('SELECT pid, wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [row.pid])).rows;
    assert.equal((await database.db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 0);
    await journal({ event: 'cooperative-settlement', interruption, error: running.error.message, blockerStillHeld: true, remainingServerBackend: remaining });
  } finally {
    clearTimeout(timer); controller.abort();
    await blocker.query('ROLLBACK').catch(() => {}); await blocker.end();
    await running?.promise;
  }
})));

for (const acquisition of ['late-success', 'timeout']) test(`cancelled acquisition handles ${acquisition} without starting application work`, { concurrency: false }, () => observedPools(() => owned(async database => {
  const target = new URL(database.connectionString), controller = new AbortController();
  const sockets = new Set(); let accepted, forward, running, called = false;
  // A test-owned transparent relay delays startup bytes. It neither decodes nor
  // changes protocol messages, and both ends connect to the owned real server.
  const server = net.createServer(client => {
    accepted = true; sockets.add(client);
    const upstream = net.connect({ host: target.hostname, port: Number(target.port) }); sockets.add(upstream);
    for (const socket of [client, upstream]) {
      socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    }
    client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
    let retained = [], bytes = 0;
    const retain = chunk => { bytes += chunk.length; assert(bytes <= 65536, 'Bounded startup relay buffer'); retained.push(chunk); };
    // Drain while retaining bytes so a peer FIN is observable during timeout.
    // Pausing the readable stream would hide that FIN from the test observer.
    client.on('data', retain);
    forward = () => {
      client.off('data', retain); for (const chunk of retained) upstream.write(chunk); retained = [];
      client.pipe(upstream); upstream.pipe(client);
    };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(database.connectionString); url.hostname = '127.0.0.1'; url.port = String(server.address().port);
  try {
    running = observed(withTypeOrmActor({ connectionString: url.toString(), signal: controller.signal }, [], async runner => {
      called = true; return runner.query('SELECT 1');
    }));
    await until(() => accepted, 'Real pg acquisition must reach the test-owned relay');
    controller.abort(new Error('Actor cancelled during acquisition'));
    const start = performance.now();
    if (acquisition === 'late-success') { await pause(30); forward(); }
    await until(() => running.settled, 'Pending acquisition must settle within its real pg timeout', acquisition === 'timeout' ? 6000 : 1000);
    assert(running.error); assert.equal(called, false);
    if (acquisition === 'timeout') assert.match(running.error.message, /connection timeout/);
    await until(() => sockets.size === 0, 'Actor acquisition sockets must close before test-owned relay cleanup');
    await noActorBackend(database);
    await journal({ event: 'acquisition-settlement', acquisition, elapsedMs: performance.now() - start, error: running.error.message,
      applicationStarted: called, relayStillListening: server.listening });
  } finally {
    controller.abort(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await running?.promise;
  }
})));

test('cancellation settles a QueryRunner waiting for the actor pool lease', { concurrency: false }, () => observedPools(pools => owned(async database => {
  const controller = new AbortController(); let acquired = false;
  const running = observed(withTypeOrmActor({ connectionString: database.connectionString, signal: controller.signal }, [], async runner => {
    const waitingRunner = runner.dataSource.createQueryRunner();
    try { await waitingRunner.connect(); acquired = true; }
    finally { await waitingRunner.release(); }
  }));
  try {
    await until(() => [...pools].some(pool => pool.waitingCount === 1), 'A second real QueryRunner must be waiting on the single actor lease');
    controller.abort(new Error('Actor cancelled during QueryRunner acquisition'));
    await until(() => running.settled, 'The waiting QueryRunner must reject after cancellation', 500);
    assert(running.error); assert.equal(acquired, false); await noActorBackend(database);
    await journal({ event: 'query-runner-acquisition', error: running.error.message, acquired });
  } finally { controller.abort(); await running.promise; }
})));

for (const phase of ['initialize', 'query']) test(`cancellation settles ${phase} while its real command stays queued at the proxy`, { concurrency: false }, () => observedPools(() => owned(async database => {
  const controller = new AbortController();
  const releases = [], errors = []; let held, running;
  const proxy = await createProxy({ upstreamUrl: database.connectionString, actor: 'alice', onError: error => errors.push(error.message), onUnit(unit) {
    if ((phase === 'initialize' && /^SELECT version\(\)/i.test(unit.sql)) || (phase === 'query' && /SELECT 42 AS marker/i.test(unit.sql))) held = unit;
    else releases.push(unit.release().catch(error => errors.push(error.message)));
  } });
  try {
    running = observed(withTypeOrmActor({ connectionString: proxy.connectionString, signal: controller.signal }, [], runner => runner.query('SELECT 42 AS marker')));
    await until(() => held, 'An actual TypeORM command must be queued before cancellation');
    assert(held.backendPid > 0); controller.abort(new Error('Actor cancelled'));
    await until(() => running.settled, 'Actor must settle without the core closing its proxy', 500);
    assert(running.error); await noActorBackend(database);
    await journal({ event: 'queued-settlement', phase, sql: held.sql, backendPid: held.backendPid, error: running.error.message, proxyStillOpen: true });
  } finally {
    controller.abort(); await proxy.close(); await running?.promise; await Promise.all(releases);
    await journal({ event: 'proxy-observations', phase, errors });
  }
})));
