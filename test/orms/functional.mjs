// Runs inside the separately installed consumer created by scripts/test-orms.mjs,
// never in the repository's root dependency graph.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { explore, parseRunArtifact, replay, verifyRegressionExport, writeRunArtifact } from '@pavangupta352/interleave';

assert(['v22.18.0', 'v24.7.0'].includes(process.version), 'ORM qualification requires Node.js 22.18.0 or 24.7.0');
const app = fileURLToPath(new URL('.', import.meta.url));
const evidence = process.env.INTERLEAVE_ORM_EVIDENCE, databaseUrl = process.env.TEST_DATABASE_URL;
const orm = process.env.INTERLEAVE_ORM, runtimeArchive = process.env.INTERLEAVE_ORM_RUNTIME_ARCHIVE;
assert(evidence && databaseUrl && orm && runtimeArchive, 'Run through scripts/test-orms.mjs');

const S = 'simple', E = 'extended';
// What each ORM really sends with its defaults, observed through the proxy. Startup
// lists every command before the first application query as [connection, SQL];
// the behavior lists are [SQL, protocol] per actor after startup. Statement lists
// for CRUD give the leading keyword and the protocol of every command.
const profiles = {
  sequelize: {
    factory: 'createSequelizeScenario',
    // Installed packages the recorded dependency graph must contain, and whether
    // a declared relationship there also reaches the application's pg.
    packages: [['sequelize', '6.37.8']], pgDependency: false,
    startup: [
      [0, "SET client_min_messages TO warning;SET TIME ZONE INTERVAL '+00:00' HOUR TO MINUTE;"],
      [0, /^WITH ranges AS \( {2}SELECT pg_range\.rngtypid, .* FROM pg_type LEFT OUTER JOIN ranges ON pg_type\.oid = ranges\.rngsubtype WHERE \(pg_type\.typtype IN\('b', 'e'\)\);$/],
      [1, "SET client_min_messages TO warning;SET TIME ZONE INTERVAL '+00:00' HOUR TO MINUTE;"],
    ],
    lostUpdate: [['SELECT "id", "value" FROM "counter" AS "Counter" WHERE "Counter"."id" = 1;', S], ['UPDATE "counter" SET "value"=$1 WHERE "id" = $2', E]],
    atomic: [['SELECT "id", "value" FROM "counter" AS "Counter" WHERE "Counter"."id" = 1;', S], ['UPDATE "counter" SET "value"="value"+ 1 WHERE "id" = 1 RETURNING *', S]],
    crud: 'START:s INSERT:e SELECT:s UPDATE:e SELECT:s COMMIT:s START:s INSERT:e INSERT:e ROLLBACK:s SELECT:s SELECT:s DELETE:s',
    begin: ['START TRANSACTION;', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;'],
    rollback: 'ROLLBACK;',
    interrupted: 'Connection terminated unexpectedly',
  },
  knex: {
    factory: 'createKnexScenario',
    packages: [['knex', '3.3.0']], pgDependency: false,
    startup: [[0, 'select version();']],
    lostUpdate: [['select "value" from "counter" where "id" = $1 limit $2', E], ['update "counter" set "value" = $1 where "id" = $2', E]],
    atomic: [['select "value" from "counter" where "id" = $1 limit $2', E], ['update "counter" set "value" = "value" + $1 where "id" = $2 returning "value"', E]],
    crud: 'BEGIN:s INSERT:e SELECT:e UPDATE:e SELECT:e COMMIT:s BEGIN:s INSERT:e INSERT:e ROLLBACK:s SELECT:e SELECT:e DELETE:e',
    begin: ['BEGIN TRANSACTION ISOLATION LEVEL serializable;'],
    rollback: 'ROLLBACK',
    interrupted: 'Connection terminated unexpectedly',
  },
  'mikro-orm': {
    factory: 'createMikroOrmScenario',
    // @mikro-orm/postgresql pins pg 8.20.0 for type parsers; Knex 3.2.10 opens
    // every connection with the application's pg 8.23.0, which the graph reaches
    // only through pg-pool's peer dependency.
    packages: [['@mikro-orm/core', '6.6.17'], ['@mikro-orm/postgresql', '6.6.17'], ['@mikro-orm/knex', '6.6.17'],
      ['knex', '3.2.10'], ['pg', '8.20.0']], pgDependency: true,
    startup: [[0, 'select version();'], [0, 'select 1']],
    lostUpdate: [['select "c0".* from "counter" as "c0" where "c0"."id" = 1 limit 1', S], ['BEGIN;', S],
      ['update "counter" set "value" = 1 where "id" = 1', S], ['COMMIT;', S]],
    atomic: [['select "c0".* from "counter" as "c0" where "c0"."id" = 1 limit 1', S], ['BEGIN;', S],
      ['update "counter" set "value" = value + 1 where "id" = 1 returning "value"', S], ['COMMIT;', S]],
    crud: 'BEGIN:s INSERT:s SELECT:s UPDATE:s SELECT:s COMMIT:s BEGIN:s INSERT:s INSERT:s ROLLBACK:s SELECT:s SELECT:s DELETE:s',
    begin: ['BEGIN TRANSACTION ISOLATION LEVEL serializable;'],
    rollback: 'ROLLBACK',
    // MikroORM's connect() reports a failed connection check without throwing,
    // so the helper rejects with the abort reason itself.
    interrupted: 'This operation was aborted',
  },
};
const profile = profiles[orm];
assert(profile, `Unknown INTERLEAVE_ORM ${orm}`);

const installed = async path => JSON.parse(await readFile(join(app, 'node_modules', path, 'package.json'), 'utf8')).version;
// Installed versions must equal the example's exact pins and the profile.
const pins = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).dependencies;
const versions = { interleave: await installed('@pavangupta352/interleave') };
for (const name of Object.keys(pins).filter(name => name !== '@pavangupta352/interleave')) {
  versions[name] = await installed(name); assert.equal(versions[name], pins[name], name);
}
for (const [name, version] of profile.packages) {
  const path = name === 'pg' && version !== pins.pg ? '@mikro-orm/postgresql/node_modules/pg' : name;
  assert.equal(await installed(path), version, `${path} must be ${version}`);
}
// The library that opens connections and Interleave's runtime load one shared
// installation of the application's pg, never a nested copy.
for (const owner of [orm === 'mikro-orm' ? 'knex' : orm, '@pavangupta352/interleave']) {
  assert.equal(createRequire(join(app, 'node_modules', owner, 'package.json')).resolve('pg'), join(app, 'node_modules/pg/lib/index.js'), owner);
}
const cli = join(app, 'node_modules/@pavangupta352/interleave/dist/cli.js');
// Journals written by the generated entry modules: import, setup and invariant calls.
const journals = { names: join(evidence, 'owned.txt'), imports: join(evidence, 'imports.txt'), invariants: join(evidence, 'invariants.jsonl') };
for (const file of Object.values(journals)) await writeFile(file, '', { flag: 'wx' });
// Library runs supervise their file targets in workers that inherit this environment.
Object.assign(process.env, { INTERLEAVE_ORM_NAMES: journals.names, INTERLEAVE_ORM_IMPORTS: journals.imports, INTERLEAVE_ORM_INVARIANTS: journals.invariants });
const lock = await readFile(join(app, 'package-lock.json'));
const budget = ['--timeout-ms', '30000'];
const commands = [], cases = [];
let server, unsafe;

const lines = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean);
async function marks() {
  return Object.fromEntries(await Promise.all(Object.entries(journals).map(async ([key, file]) => [key, (await lines(file)).length])));
}
async function since(before) {
  const now = Object.fromEntries(await Promise.all(Object.entries(journals).map(async ([key, file]) => [key, (await lines(file)).slice(before[key])])));
  return { ...now, invariants: now.invariants.map(line => JSON.parse(line)) };
}
async function execute(args, cwd = app) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '' } });
  const index = commands.length + 1, prefix = join(evidence, String(index).padStart(2, '0'));
  const record = { index, command: process.execPath, args, cwd, pid: result.pid, status: result.status, signal: result.signal, error: result.error?.message };
  commands.push(record);
  await Promise.all([writeFile(prefix + '.json', JSON.stringify(record, null, 2) + '\n'),
    writeFile(prefix + '.stdout', result.stdout ?? ''), writeFile(prefix + '.stderr', result.stderr ?? '')]);
  assert.equal(result.error, undefined, `Command ${index} did not finish: ${result.error?.message}`);
  assert.equal(result.signal, null, `Command ${index} ended by ${result.signal}`);
  return { ...record, stdout: result.stdout, stderr: result.stderr };
}
function explain(run) {
  return JSON.stringify({ outcome: run.outcome, reason: run.reason, failure: run.failure?.message, actors: run.actors,
    steps: run.trace.map(step => [step.index, step.actor, step.connection, step.protocol, step.sql.slice(0, 60), step.completion?.error?.code, step.completion?.transactionStatus]) });
}
// One generated entry per behavior. Journals are written only when their
// variables are set, so an exported bundle also replays without them; the
// application scenario itself is unchanged. `interrupted` replaces bob with an
// operation that only waits for cancellation.
function entrySource(name, behavior, interrupted = false) {
  return `import { appendFile } from 'node:fs/promises';
import { ${profile.factory} } from './scenario.mjs';

// Qualification journals; the application scenario itself is unchanged.
const journal = (name, line) => process.env[name] ? appendFile(process.env[name], line + '\\n') : undefined;
await journal('INTERLEAVE_ORM_IMPORTS', ${JSON.stringify(name)});
const scenario = ${profile.factory}(${JSON.stringify(behavior)});
export default { ...scenario,${interrupted ? `
  actors: { alice: scenario.actors.alice,
    async bob({ signal }) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } },` : ''}
  async setup(context) {
    await journal('INTERLEAVE_ORM_NAMES', new URL(context.connectionString).pathname.slice(1));
    await scenario.setup(context);
  },
  async invariant(context) {
    const note = event => journal('INTERLEAVE_ORM_INVARIANTS', JSON.stringify({ entry: ${JSON.stringify(name)},
      database: new URL(context.connectionString).pathname.slice(1), ...event }));
    await note({ event: 'invoked' });
    try { await scenario.invariant(context); }
    catch (error) { await note({ event: 'threw', name: error?.name }); throw error; }
    await note({ event: 'returned' });
  },
};
`;
}
async function entry(name, behavior = name, interrupted = false) {
  const file = `${name}.mjs`, source = entrySource(name, behavior, interrupted);
  try { await writeFile(join(app, file), source, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(join(app, file), 'utf8'), source); }
  return file;
}
// One explicit schedule per command. A passing sample stops at the one-run
// budget (exit 4); a violation stops the search (exit 1); a rejected actor is
// a hard failure (exit 2). The retained run carries the outcome itself.
async function record(behavior, plan, { suffix = '', outcome, status, stopReason, timeout = budget, interrupted = false }) {
  const file = await entry(behavior + suffix, behavior, interrupted), artifact = join(evidence, `${behavior}${suffix}.json`);
  const before = await marks();
  // The CLI rejects an empty --plan; omitting it selects the fair fallback.
  const schedule = plan.length ? ['--plan', plan.join(',')] : [];
  const command = await execute([cli, 'run', file, '--project-root', app, ...schedule, '--max-runs', '1', ...timeout, '--out', artifact, '--json']);
  const run = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
  assert.equal(run.outcome, outcome, explain(run));
  assert.equal(command.status, status, explain(run));
  const search = JSON.parse(command.stdout);
  assert.equal(search.stopReason, stopReason); assert.equal(search.explored, 1);
  assert.equal(search.runs.length, 1); assert.deepEqual(parseRunArtifact(search.runs[0]), run);
  assert.deepEqual(run.plan, plan); assert.equal(run.cleanup.complete, true);
  assert.equal(run.environment.nodeVersion, process.version); server ??= run.environment.serverVersion;
  assert.equal(run.environment.serverVersion, server);
  const observed = await since(before);
  assert.equal(observed.names.length, 1); assert.deepEqual(observed.imports, [behavior + suffix]);
  return { run, file, artifact, observed };
}
function qualify(name, body) {
  test(name, async () => {
    const item = { name, status: 'failed' }; cases.push(item);
    const started = performance.now();
    try { await body(); item.status = 'passed'; }
    finally { item.durationMs = Math.round(performance.now() - started); }
  });
}
const alternate = count => Array.from({ length: count }, () => ['alice', 'bob']).flat();
const events = observed => observed.invariants.map(item => item.event);
const actorSteps = (run, actor) => run.trace.filter(step => step.actor === actor);
const appSteps = (run, actor) => actorSteps(run, actor).slice(profile.startup.length);
const keyword = step => step.sql.split(/[\s;]/)[0].toUpperCase();
const sameSql = (actual, expected) => expected instanceof RegExp ? expected.test(actual) : actual === expected;
// Each actor first sends its ORM's startup commands, then all of its application
// commands on one connection and one backend.
function startup(run) {
  const generations = [...new Set(profile.startup.map(([connection]) => connection))];
  assert.deepEqual(run.connections.map(item => `${item.actor}#${item.connection}`).sort(),
    ['alice', 'bob'].flatMap(actor => generations.map(connection => `${actor}#${connection}`)));
  // Every connection of every actor presents the same startup parameters.
  assert.equal(new Set(run.connections.map(item => item.fingerprint)).size, 1);
  for (const actor of ['alice', 'bob']) {
    const steps = actorSteps(run, actor);
    profile.startup.forEach(([connection, sql], index) => {
      assert.equal(steps[index].connection, connection, explain(run)); assert.equal(steps[index].protocol, S);
      assert(sameSql(steps[index].sql, sql), steps[index].sql); assert.equal(steps[index].completion.error, undefined);
    });
    const rest = appSteps(run, actor);
    assert(rest.length > 0); assert.equal(new Set(rest.map(step => `${step.connection}:${step.backendPid}`)).size, 1);
    assert.equal(rest[0].connection, profile.startup.at(-1)[0]);
  }
}
function commandsMatch(steps, expected) {
  assert.deepEqual(steps.map(step => [step.sql, step.protocol]), expected);
}
const replayMatches = (repeated, original) => {
  assert.deepEqual(repeated.failure, original.failure); assert.deepEqual(repeated.actors, original.actors);
  assert.deepEqual(repeated.environment.source, original.environment.source); assert.deepEqual(repeated.environment.fixture, original.environment.fixture);
  assert.deepEqual(repeated.trace.map(step => step.fingerprint), original.trace.map(step => step.fingerprint));
  assert.equal(repeated.cleanup.complete, true);
};
// Both snapshot reads precede the competing UPDATEs; alice's COMMIT releases bob.
function serializationFailure(run) {
  const failed = run.trace.filter(step => step.completion?.error);
  assert.equal(failed.length, 1, explain(run));
  const [step] = failed, alice = actorSteps(run, 'alice');
  const write = alice.find(item => /^update "counter"/i.test(item.sql));
  assert.equal(step.actor, 'bob'); assert.match(step.sql, /^update "counter"/i);
  assert.equal(step.completion.error.code, '40001'); assert.equal(step.completion.transactionStatus, 'E');
  assert(step.waits.some(wait => wait.waitEventType === 'Lock' && wait.blockerPids.includes(write.backendPid)), JSON.stringify(step.waits));
  // Alice's COMMIT was released while bob's UPDATE waited on her row lock.
  const commit = alice.find(item => item.sql === 'COMMIT;');
  assert(commit.index > step.index, JSON.stringify({ commit: commit.index, update: step.index }));
  const rollbacks = run.trace.filter(item => item.sql === profile.rollback);
  assert.equal(rollbacks.length, 1); assert.equal(rollbacks[0].actor, 'bob'); assert.equal(rollbacks[0].completion.transactionStatus, 'I');
  assert.equal(commit.completion.transactionStatus, 'I');
  return { step, commit, rollback: rollbacks[0] };
}
const first = { attempts: 1, reads: [0], errors: [], rollbackVerified: false };
// Commands per actor: through the competing UPDATE, and for a whole transaction.
const lostUpdateLength = profile.startup.length + profile.lostUpdate.length;
const updateLength = profile.startup.length + profile.begin.length + 3;
const transactionLength = updateLength + 1;

qualify('unsafe read-then-write records a real lost update through the CLI, and exact replay repeats it', async () => {
  unsafe = await record('lost-update', alternate(lostUpdateLength), { outcome: 'violation', status: 1, stopReason: 'failure' });
  const { run, observed } = unsafe;
  assert.deepEqual(run.actors.map(actor => actor.value), [{ read: 0, written: 1 }, { read: 0, written: 1 }]);
  assert.equal(run.trace.length, 2 * lostUpdateLength); assert.match(run.failure.message, /Expected both increments to be retained/);
  assert.deepEqual(events(observed), ['invoked', 'threw']); assert.equal(observed.invariants[1].name, 'AssertionError');
  // The ORM's real startup commands are scheduled units like any other.
  startup(run);
  for (const actor of ['alice', 'bob']) commandsMatch(appSteps(run, actor), profile.lostUpdate);
  assert(run.trace.every(step => !step.completion.error));
  const source = run.environment.source, { dependencies, runtime } = source.components;
  for (const [name, version] of profile.packages) {
    assert(dependencies.packages.some(item => item.name === name && item.version === version && item.fileCount > 0), `${name}@${version}`);
  }
  // Each ORM loads pg with a computed require and declares it only in
  // peerDependenciesMeta, which the dependency graph does not follow. The shared
  // installation is always recorded as Interleave's own runtime dependency.
  assert.equal(dependencies.packages.some(item => item.name === 'pg' && item.version === pins.pg), profile.pgDependency);
  const pgRoot = runtime.dependencies.roots.find(root => root.name === 'pg');
  assert.equal(runtime.dependencies.packages.find(item => item.id === pgRoot.packageId)?.version, pins.pg);
  assert(source.components.source.files.some(file => file.path === 'package-lock.json'));
  await writeFile(join(evidence, 'identity.json'), JSON.stringify({ byteCount: source.byteCount, fileCount: source.fileCount,
    sharedPackages: source.sharedPackages.length, dependencies: dependencies.packages.map(item => `${item.name}@${item.version}`).sort(),
    runtime: runtime.dependencies.packages.map(item => `${item.name}@${item.version}`).sort(),
    sourceFiles: source.components.source.files.map(file => file.path) }, null, 2) + '\n');

  const before = await marks();
  const command = await execute([cli, 'replay', unsafe.file, unsafe.artifact, ...budget, '--json']);
  const repeated = parseRunArtifact(JSON.parse(command.stdout));
  assert.equal(repeated.outcome, 'violation', explain(repeated)); assert.equal(command.status, 1); assert.equal(repeated.mode, 'replay');
  replayMatches(repeated, run); assert.deepEqual(events(await since(before)), ['invoked', 'threw']);
});

qualify('the library API finds the same lost update and replays it exactly', async () => {
  assert(unsafe, 'Requires the recorded unsafe run');
  const file = join(app, unsafe.file);
  const options = { databaseUrl, timeoutMs: 30_000, source: { projectRoot: app } };
  const before = await marks();
  const search = await explore(file, { ...options, maxRuns: 20 });
  assert.equal(search.stopReason, 'failure'); assert.equal(search.firstFailure?.outcome, 'violation');
  const found = search.firstFailure;
  assert.deepEqual(found.failure, unsafe.run.failure); assert.equal(found.cleanup.complete, true);
  await writeRunArtifact(join(evidence, 'api-lost-update.json'), found);
  const repeated = await replay(file, found, options);
  assert.equal(repeated.outcome, 'violation', explain(repeated)); assert.equal(repeated.mode, 'replay'); replayMatches(repeated, found);
  const observed = await since(before);
  assert.equal(observed.names.length, search.explored + 1);
  await writeFile(join(evidence, 'api-summary.json'), JSON.stringify({ explored: search.explored, metrics: search.metrics, plan: found.plan }, null, 2) + '\n');
});

qualify('CLI minimization keeps the same lost-update failure', async () => {
  assert(unsafe, 'Requires the recorded unsafe run');
  const before = await marks(), output = join(evidence, 'lost-update-minimal.json');
  const command = await execute([cli, 'minimize', unsafe.file, unsafe.artifact, ...budget, '--max-attempts', '16', '--total-timeout-ms', '120000', '--out', output, '--json']);
  const reduced = JSON.parse(command.stdout);
  assert.equal(reduced.stopReason, 'locally-minimal', JSON.stringify({ reason: reduced.reason, attemptFailure: reduced.attemptFailure }));
  assert.equal(command.status, 1); assert.equal(reduced.locallyMinimal, true); assert.equal(reduced.attemptFailure, undefined);
  assert(reduced.reducedChoices < reduced.originalChoices); assert.equal(reduced.originalChoices, unsafe.run.trace.length);
  assert.deepEqual(reduced.run.failure, unsafe.run.failure); assert.equal(reduced.run.trace.length, unsafe.run.trace.length); assert.equal(reduced.run.cleanup.complete, true);
  assert.deepEqual(parseRunArtifact(JSON.parse(await readFile(output, 'utf8'))), parseRunArtifact(reduced.run));
  assert.equal((await since(before)).names.length, reduced.attempts);
  await writeFile(join(evidence, 'minimize-summary.json'), JSON.stringify({ attempts: reduced.attempts,
    originalChoices: reduced.originalChoices, reducedChoices: reduced.reducedChoices }, null, 2) + '\n');
});

qualify('the atomic write keeps the read and retains both increments under the same alternation', async () => {
  const { run, observed } = await record('atomic', alternate(lostUpdateLength), { outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert.deepEqual(run.actors.map(actor => actor.value), [{ read: 0, written: 1 }, { read: 0, written: 2 }]);
  assert.deepEqual(events(observed), ['invoked', 'returned']); startup(run);
  for (const actor of ['alice', 'bob']) commandsMatch(appSteps(run, actor), profile.atomic);
});

qualify('after switching the entry to the atomic behavior, exact replay is rejected before import and guided replay passes', async () => {
  assert(unsafe, 'Requires the recorded unsafe run');
  const path = join(app, unsafe.file), original = await readFile(path);
  try {
    await writeFile(path, entrySource('lost-update', 'atomic'));
    let before = await marks();
    const exact = await execute([cli, 'replay', unsafe.file, unsafe.artifact, ...budget, '--json']);
    const rejected = parseRunArtifact(JSON.parse(exact.stdout));
    assert.equal(rejected.outcome, 'incompatible', explain(rejected)); assert.equal(exact.status, 3);
    assert.equal(rejected.reason, 'Replay source, installed dependencies or Interleave runtime identity changed');
    assert.deepEqual(rejected.trace, []); assert.deepEqual(await since(before), { names: [], imports: [], invariants: [] });
    before = await marks();
    const guided = await execute([cli, 'replay', unsafe.file, unsafe.artifact, '--guided', '--out', join(evidence, 'atomic-guided.json'), ...budget, '--json']);
    const rerun = parseRunArtifact(JSON.parse(guided.stdout));
    assert.equal(rerun.mode, 'guided'); assert.equal(rerun.outcome, 'passed', explain(rerun)); assert.equal(guided.status, 0);
    assert.deepEqual(rerun.plan, unsafe.run.trace.map(step => step.actor));
    assert.notEqual(rerun.environment.source.fingerprint, unsafe.run.environment.source.fingerprint);
    assert.deepEqual(rerun.actors.map(actor => actor.value), [{ read: 0, written: 1 }, { read: 0, written: 2 }]);
    for (const actor of ['alice', 'bob']) commandsMatch(appSteps(rerun, actor), profile.atomic);
    assert.deepEqual(events(await since(before)), ['invoked', 'returned']);
  } finally { await writeFile(path, original); }
  assert((await readFile(path)).equals(original));
});

qualify('CRUD commits, a 23505 transaction rolls back its marker, and the same connection keeps working', async () => {
  const { run, observed } = await record('crud-rollback', [], { outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert.deepEqual(run.actors.map(actor => actor.value), Array(2).fill({ inserted: 1, updated: 2, code: '23505', committed: 2, markerRows: 0, deleted: 1 }));
  assert.deepEqual(events(observed), ['invoked', 'returned']); startup(run);
  for (const actor of ['alice', 'bob']) {
    const steps = appSteps(run, actor), failed = steps.findIndex(step => step.completion?.error);
    assert.equal(steps.map(step => `${keyword(step)}:${step.protocol[0]}`).join(' '), profile.crud);
    assert.deepEqual(steps.filter(step => step.completion?.error).map(step => [step.completion.error.code, step.completion.transactionStatus]), [['23505', 'E']]);
    assert.match(steps[failed].sql, /^insert into "entries"/i); assert.equal(steps[failed - 1].completion.transactionStatus, 'T');
    assert.equal(steps[failed + 1].sql, profile.rollback); assert.equal(steps[failed + 1].completion.transactionStatus, 'I');
    assert.deepEqual(steps.filter(step => step.sql === 'COMMIT;').map(step => step.completion.transactionStatus), ['I']);
    const recovered = steps.slice(failed + 2);
    assert(recovered.length >= 3 && recovered.every(step => !step.completion.error && step.completion.transactionStatus === 'I'));
    for (const step of steps.filter(step => step.protocol === E)) assert.match(step.sql, /\$1/);
  }
});

qualify('an unhandled serialization failure is an actor error and the invariant is never invoked', async () => {
  const { run, observed } = await record('serializable-error', [...alternate(updateLength), 'alice'], { outcome: 'actor-error', status: 2, stopReason: 'inconclusive' });
  assert.equal(run.reason, 'One or more application operations rejected; the invariant was not evaluated');
  assert.equal(run.failure, undefined); assert.deepEqual(observed.invariants, []); startup(run);
  assert.deepEqual(run.actors[0], { actor: 'alice', status: 'fulfilled', value: first });
  assert.equal(run.actors[1].status, 'rejected'); assert.match(run.actors[1].error, /could not serialize access due to concurrent update/);
  const { rollback } = serializationFailure(run);
  // Bob's marker check after ROLLBACK is his last command before rejecting.
  assert.deepEqual(actorSteps(run, 'bob').filter(step => step.index > rollback.index).map(step => /from "attempts"/i.test(step.sql)), [true]);
});

qualify('whole-transaction retry restarts after 40001 with a fresh read and no surviving failed marker', async () => {
  const { run, observed } = await record('serializable-retry', [...alternate(updateLength), 'alice'], { outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert.deepEqual(run.actors.map(actor => actor.value), [first, { attempts: 2, reads: [0, 1], errors: ['40001'], rollbackVerified: true }]);
  assert.deepEqual(events(observed), ['invoked', 'returned']); startup(run);
  const { commit, rollback } = serializationFailure(run);
  const retried = actorSteps(run, 'bob').filter(step => step.index > rollback.index);
  const expected = [/from "attempts"/i, ...profile.begin, /^insert into "attempts"/i, /from "counter"/i, /^update "counter"/i, 'COMMIT;'];
  assert.equal(retried.length, expected.length, JSON.stringify(retried.map(step => step.sql)));
  retried.forEach((step, index) => { assert(sameSql(step.sql, expected[index]), step.sql); assert.equal(step.completion.error, undefined); });
  const read = retried.findIndex(step => /from "counter"/i.test(step.sql));
  assert(retried[read].index > commit.index); assert.equal(retried.at(-1).completion.transactionStatus, 'I');
});

for (const behavior of ['serializable-error', 'serializable-retry']) qualify(`${behavior} commits once per actor under a serial schedule`, async () => {
  const { run, observed } = await record(behavior, [...Array(transactionLength).fill('alice'), ...Array(transactionLength).fill('bob')],
    { suffix: '-serial', outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert(run.trace.every(step => !step.completion.error)); assert.equal(run.trace.length, 2 * transactionLength);
  assert.deepEqual(run.actors.map(actor => actor.value), [first, { ...first, reads: [1] }]);
  assert.deepEqual(events(observed), ['invoked', 'returned']); startup(run);
});

qualify('a changed helper is rejected before scenario import or database setup', async () => {
  assert(unsafe, 'Requires the recorded unsafe run');
  const helper = join(app, 'connection.mjs'), original = await readFile(helper), before = await marks();
  try {
    await writeFile(helper, Buffer.concat([original, Buffer.from('\n// Source drift qualification.\n')]));
    const command = await execute([cli, 'replay', unsafe.file, unsafe.artifact, ...budget, '--json']);
    const drift = parseRunArtifact(JSON.parse(command.stdout));
    assert.equal(drift.outcome, 'incompatible', explain(drift)); assert.equal(command.status, 3);
    assert.equal(drift.reason, 'Replay source, installed dependencies or Interleave runtime identity changed');
    assert.deepEqual(drift.trace, []); assert.equal(drift.cleanup.complete, true);
    assert.deepEqual(await since(before), { names: [], imports: [], invariants: [] });
  } finally { await writeFile(helper, original); }
  assert((await readFile(helper)).equals(original));
});

qualify('a deadline while the first ORM command is unreleased settles both actors and cleans up', async () => {
  // Bob only waits for cancellation, so no decision is ever made and alice's
  // first command cannot be released before the deadline.
  const { run, observed } = await record('lost-update', [], { suffix: '-interrupted', outcome: 'inconclusive', status: 4,
    stopReason: 'inconclusive', timeout: ['--timeout-ms', '5000'], interrupted: true });
  assert.equal(run.reason, 'Execution exceeded its 5000 ms deadline');
  assert.deepEqual(run.trace, []); assert.deepEqual(observed.invariants, []);
  // Alice's connection was admitted before the deadline; both operations settled.
  assert.deepEqual(run.connections.map(item => `${item.actor}#${item.connection}`), ['alice#0']);
  assert.deepEqual(run.actors, [{ actor: 'alice', status: 'rejected', error: profile.interrupted }, { actor: 'bob', status: 'fulfilled' }]);
});

qualify('original-archive export installs offline and replays the same failure exactly', async () => {
  assert(unsafe, 'Requires the recorded unsafe run');
  const destination = join(evidence, 'portable');
  const command = await execute([cli, 'export', unsafe.file, unsafe.artifact, '--project-root', app,
    '--runtime-archive', runtimeArchive, '--out', destination, '--json']);
  assert.equal(command.status, 0, command.stderr || command.stdout);
  const exported = JSON.parse(command.stdout), manifest = await verifyRegressionExport(destination);
  await writeFile(join(evidence, 'export-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  assert.equal(manifest.installation.layout, 'shared-app');
  assert((await readFile(join(destination, 'app/package-lock.json'))).equals(lock));
  assert((await readFile(join(destination, 'run.json'))).equals(await readFile(unsafe.artifact)));
  const installation = await execute(['install.mjs', '--offline'], destination);
  assert.equal(installation.status, 0, installation.stderr); assert.match(installation.stdout, /complete installed identity match/);
  const [node, ...args] = exported.replay.command; assert.equal(node, 'node');
  const before = await marks();
  const exportedReplay = await execute([...args, ...budget, '--json'], destination);
  const replayed = parseRunArtifact(JSON.parse(exportedReplay.stdout));
  assert.equal(replayed.outcome, 'violation', explain(replayed)); assert.equal(exportedReplay.status, 1); assert.equal(replayed.mode, 'replay');
  replayMatches(replayed, unsafe.run);
  const observed = await since(before);
  assert.equal(observed.names.length, 1); assert.deepEqual(events(observed), ['invoked', 'threw']);
});

qualify('generated databases, backends and command processes are absent; the application lock is unchanged', async () => {
  const names = await lines(journals.names);
  assert(names.length > 0);
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const databases = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names])).rows;
    const backends = (await admin.query('SELECT pid FROM pg_stat_activity WHERE datname = ANY($1::text[])', [names])).rows;
    const pids = commands.map(command => { let absent = false; try { process.kill(command.pid, 0); } catch (error) { if (error.code === 'ESRCH') absent = true; else throw error; } return { pid: command.pid, absent }; });
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ names, databases, backends, pids }, null, 2) + '\n');
    assert.deepEqual(databases, []); assert.deepEqual(backends, []); assert(pids.every(item => item.absent));
  } finally { await admin.end(); }
  assert((await readFile(join(app, 'package-lock.json'))).equals(lock));
});

after(async () => {
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ orm, node: process.version, server, versions,
    passed: cases.length > 0 && cases.every(item => item.status === 'passed'), cases, commands: commands.length }, null, 2) + '\n');
});
