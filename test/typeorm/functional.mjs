// Runs inside the separately installed consumer, never the root dependency graph.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseRunArtifact, verifyRegressionExport } from '@pavangupta352/interleave';

assert.equal(process.version, 'v22.18.0', 'TypeORM functional qualification requires Node22.18.0');
const app = fileURLToPath(new URL('.', import.meta.url));
const evidence = process.env.INTERLEAVE_TYPEORM_EVIDENCE, databaseUrl = process.env.TEST_DATABASE_URL;
assert(evidence && databaseUrl, 'Run through scripts/test-typeorm-functional.mjs');
const portable = process.env.INTERLEAVE_TYPEORM_PORTABLE === '1';
const installed = async name => JSON.parse(await readFile(join(app, 'node_modules', name, 'package.json'), 'utf8')).version;
const versions = { typeorm: await installed('typeorm'), pg: await installed('pg'), interleave: await installed('@pavangupta352/interleave') };
assert.equal(versions.typeorm, '1.1.1'); assert.equal(versions.pg, '8.23.0');
const cli = join(app, 'node_modules/@pavangupta352/interleave/dist/cli.js');
// Journals written by the generated entry modules: import, setup and invariant calls.
const journals = { names: join(evidence, 'owned.txt'), imports: join(evidence, 'imports.txt'), invariants: join(evidence, 'invariants.jsonl') };
for (const file of Object.values(journals)) await writeFile(file, '', { flag: 'wx' });
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
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', INTERLEAVE_TYPEORM_NAMES: journals.names,
      INTERLEAVE_TYPEORM_IMPORTS: journals.imports, INTERLEAVE_TYPEORM_INVARIANTS: journals.invariants } });
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
    errors: run.trace.filter(step => step.completion?.error).map(step => ({ index: step.index, actor: step.actor, sql: step.sql,
      code: step.completion.error.code, message: step.completion.error.message, state: step.completion.transactionStatus })) });
}
async function entry(behavior) {
  const file = `${behavior}.mjs`;
  const source = `import { appendFile } from 'node:fs/promises';
import { createTypeOrmScenario } from './scenario.mjs';

// Qualification journals; the application scenario itself is unchanged.
const journal = (name, line) => process.env[name] ? appendFile(process.env[name], line + '\\n') : undefined;
await journal('INTERLEAVE_TYPEORM_IMPORTS', '${behavior}');
const scenario = createTypeOrmScenario('${behavior}');
export default { ...scenario,
  async setup(context) {
    await journal('INTERLEAVE_TYPEORM_NAMES', new URL(context.connectionString).pathname.slice(1));
    await scenario.setup(context);
  },
  async invariant(context) {
    const note = event => journal('INTERLEAVE_TYPEORM_INVARIANTS', JSON.stringify({ behavior: '${behavior}',
      database: new URL(context.connectionString).pathname.slice(1), ...event }));
    await note({ event: 'invoked' });
    try { await scenario.invariant(context); }
    catch (error) { await note({ event: 'threw', name: error?.name }); throw error; }
    await note({ event: 'returned' });
  },
};
`;
  try { await writeFile(join(app, file), source, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(join(app, file), 'utf8'), source); }
  return file;
}
// One explicit schedule per command. A passing sample stops at the one-run
// budget (exit 4); a violation stops the search (exit 1); a rejected actor is
// a hard failure (exit 2). The retained run carries the outcome itself.
async function record(behavior, plan, { suffix = '', outcome, status, stopReason }) {
  const file = await entry(behavior), artifact = join(evidence, `${behavior}${suffix}.json`);
  const before = await marks();
  // The CLI rejects an empty --plan; omitting it selects the fair fallback.
  const schedule = plan.length ? ['--plan', plan.join(',')] : [];
  const command = await execute([cli, 'run', file, '--project-root', app, ...schedule, '--max-runs', '1', ...budget, '--out', artifact, '--json']);
  const run = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
  assert.equal(run.outcome, outcome, explain(run));
  assert.equal(command.status, status, explain(run));
  const search = JSON.parse(command.stdout);
  assert.equal(search.stopReason, stopReason); assert.equal(search.explored, 1);
  assert.equal(search.runs.length, 1); assert.deepEqual(parseRunArtifact(search.runs[0]), run);
  assert.deepEqual(run.plan, plan); assert.equal(run.cleanup.complete, true);
  assert.equal(run.environment.nodeVersion, process.version); server ??= run.environment.serverVersion;
  assert.equal(run.environment.serverVersion, server);
  assert(run.environment.source.components.dependencies.packages.some(item => item.name === 'typeorm' && item.version === '1.1.1'));
  const observed = await since(before);
  assert.equal(observed.names.length, 1); assert.deepEqual(observed.imports, [behavior]);
  return { run, file, artifact, observed };
}
function qualify(name, body, options = {}) {
  test(name, options, async () => {
    const entry = { name, status: 'failed' }; cases.push(entry);
    await body(); entry.status = 'passed';
  });
}
const alternate = count => Array.from({ length: count }, () => ['alice', 'bob']).flat();
const events = observed => observed.invariants.map(item => item.event);
const actorSteps = (run, actor) => run.trace.filter(step => step.actor === actor);
function sameConnection(run) {
  for (const actor of ['alice', 'bob']) {
    const steps = actorSteps(run, actor);
    assert(steps.length > 0); assert.equal(new Set(steps.map(step => `${step.connection}:${step.backendPid}`)).size, 1);
  }
}
// Both snapshot reads precede the competing UPDATEs; alice's COMMIT releases bob.
function serializationFailure(run) {
  const failed = run.trace.filter(step => step.completion?.error);
  assert.equal(failed.length, 1, explain(run));
  const [step] = failed, alice = actorSteps(run, 'alice');
  assert.equal(step.actor, 'bob'); assert.match(step.sql, /^UPDATE "counter"/);
  assert.equal(step.completion.error.code, '40001'); assert.equal(step.completion.transactionStatus, 'E');
  assert(step.waits.some(wait => wait.waitEventType === 'Lock' && wait.blockerPids.includes(alice[0].backendPid)), JSON.stringify(step.waits));
  // Alice's COMMIT was released while bob's UPDATE waited on her row lock.
  const commit = alice.find(item => item.sql === 'COMMIT');
  assert(commit.index > step.index, JSON.stringify({ commit: commit.index, update: step.index }));
  const rollbacks = run.trace.filter(item => item.sql === 'ROLLBACK');
  assert.equal(rollbacks.length, 1); assert.equal(rollbacks[0].actor, 'bob'); assert.equal(rollbacks[0].completion.transactionStatus, 'I');
  assert.equal(commit.completion.transactionStatus, 'I');
  return { step, commit, rollback: rollbacks[0] };
}
const first = { attempts: 1, reads: [0], errors: [], rollbackVerified: false };

qualify('unsafe entity-manager read-modify-write records a real lost update and replays exactly', async () => {
  unsafe = await record('lost-update', alternate(4), { outcome: 'violation', status: 1, stopReason: 'failure' });
  const { run, observed } = unsafe;
  assert.deepEqual(run.actors.map(actor => actor.value), [{ read: 0, written: 1 }, { read: 0, written: 1 }]);
  assert.equal(run.trace.length, 8); assert.match(run.failure.message, /Expected both increments to be retained/);
  assert.deepEqual(events(observed), ['invoked', 'threw']); assert.equal(observed.invariants[1].name, 'AssertionError');
  // TypeORM's real initialization queries are scheduled units, then parameterized entity work.
  assert.deepEqual(run.trace.slice(0, 4).map(step => [step.actor, step.sql]), [['alice', 'SELECT version()'], ['bob', 'SELECT version()'],
    ['alice', 'SELECT * FROM current_schema()'], ['bob', 'SELECT * FROM current_schema()']]);
  for (const step of run.trace.slice(4)) { assert.equal(step.protocol, 'extended'); assert.match(step.sql, /\$1/); }
  const before = await marks();
  const command = await execute([cli, 'replay', unsafe.file, unsafe.artifact, ...budget, '--json']);
  const repeated = parseRunArtifact(JSON.parse(command.stdout));
  assert.equal(repeated.outcome, 'violation', explain(repeated)); assert.equal(command.status, 1); assert.equal(repeated.mode, 'replay');
  assert.deepEqual(repeated.failure, run.failure); assert.deepEqual(repeated.actors, run.actors);
  assert.deepEqual(repeated.environment.source, run.environment.source); assert.deepEqual(repeated.environment.fixture, run.environment.fixture);
  assert.deepEqual(repeated.trace.map(step => step.fingerprint), run.trace.map(step => step.fingerprint));
  assert.equal(repeated.cleanup.complete, true); assert.deepEqual(events(await since(before)), ['invoked', 'threw']);
});

qualify('atomic UPDATE RETURNING retains both increments under the same alternation', async () => {
  const { run, observed } = await record('atomic', alternate(3), { outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert.deepEqual(run.actors.map(actor => actor.value), [{ written: 1 }, { written: 2 }]);
  assert.deepEqual(events(observed), ['invoked', 'returned']);
});

qualify('entity CRUD commits, a 23505 transaction rolls back its marker, and the connection recovers', async () => {
  const { run, observed } = await record('crud-rollback', [], { outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert.deepEqual(run.actors.map(actor => actor.value), Array(2).fill({ inserted: 1, updated: 2, code: '23505', committed: 2, markerRows: 0, deleted: 1 }));
  assert.deepEqual(events(observed), ['invoked', 'returned']); sameConnection(run);
  for (const actor of ['alice', 'bob']) {
    const steps = actorSteps(run, actor), failed = steps.findIndex(step => step.completion?.error);
    assert.deepEqual(steps.filter(step => step.completion?.error).map(step => [step.completion.error.code, step.completion.transactionStatus]), [['23505', 'E']]);
    assert.match(steps[failed].sql, /^INSERT INTO "entries"/); assert.equal(steps[failed - 1].completion.transactionStatus, 'T');
    assert.equal(steps[failed + 1].sql, 'ROLLBACK'); assert.equal(steps[failed + 1].completion.transactionStatus, 'I');
    assert.deepEqual(steps.filter(step => step.sql === 'COMMIT').map(step => step.completion.transactionStatus), ['I']);
    const recovered = steps.slice(failed + 2);
    assert(recovered.length >= 3 && recovered.every(step => !step.completion.error && step.completion.transactionStatus === 'I'));
    for (const verb of ['INSERT', 'UPDATE', 'DELETE']) assert(steps.some(step => step.sql.startsWith(verb) && step.protocol === 'extended' && step.sql.includes('$1')), verb);
  }
});

qualify('unhandled serialization failure is an actor error and the invariant is never invoked', async () => {
  const { run, observed } = await record('serializable-error', [...alternate(7), 'alice'], { outcome: 'actor-error', status: 2, stopReason: 'inconclusive' });
  assert.equal(run.reason, 'One or more application operations rejected; the invariant was not evaluated');
  assert.equal(run.failure, undefined); assert.deepEqual(observed.invariants, []);
  assert.deepEqual(run.actors[0], { actor: 'alice', status: 'fulfilled', value: first });
  assert.equal(run.actors[1].status, 'rejected'); assert.match(run.actors[1].error, /could not serialize access due to concurrent update/);
  const { rollback } = serializationFailure(run);
  // Bob's marker check after ROLLBACK is his last command before rejecting.
  assert.deepEqual(actorSteps(run, 'bob').filter(step => step.index > rollback.index).map(step => step.sql.match(/FROM "attempts"/) !== null), [true]);
});

qualify('whole-transaction retry restarts after 40001 with a fresh read and no surviving failed marker', async () => {
  const { run, observed } = await record('serializable-retry', [...alternate(7), 'alice'], { outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert.deepEqual(run.actors.map(actor => actor.value), [first, { attempts: 2, reads: [0, 1], errors: ['40001'], rollbackVerified: true }]);
  assert.deepEqual(events(observed), ['invoked', 'returned']); sameConnection(run);
  const { commit, rollback } = serializationFailure(run);
  const retried = actorSteps(run, 'bob').filter(step => step.index > rollback.index);
  const expected = [/FROM "attempts"/, /^START TRANSACTION$/, /^SET TRANSACTION ISOLATION LEVEL SERIALIZABLE$/, /^INSERT INTO "attempts"/,
    /FROM "counter"/, /^UPDATE "counter"/, /^COMMIT$/];
  assert.equal(retried.length, expected.length, JSON.stringify(retried.map(step => step.sql)));
  retried.forEach((step, index) => { assert.match(step.sql, expected[index]); assert.equal(step.completion.error, undefined); });
  assert(retried[4].index > commit.index); assert.equal(retried.at(-1).completion.transactionStatus, 'I');
});

for (const behavior of ['serializable-error', 'serializable-retry']) qualify(`${behavior} commits once per actor under a serial schedule`, async () => {
  const { run, observed } = await record(behavior, [...Array(8).fill('alice'), ...Array(8).fill('bob')], { suffix: '-serial', outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert(run.trace.every(step => !step.completion.error)); assert.equal(run.trace.length, 16);
  assert.deepEqual(run.actors.map(actor => actor.value), [first, { ...first, reads: [1] }]);
  assert.deepEqual(events(observed), ['invoked', 'returned']);
});

if (portable) {
  qualify('minimization keeps the same TypeORM lost-update failure', async () => {
    assert(unsafe, 'Requires the recorded unsafe failure');
    const before = await marks(), output = join(evidence, 'lost-update-minimal.json');
    const command = await execute([cli, 'minimize', unsafe.file, unsafe.artifact, ...budget, '--max-attempts', '16', '--total-timeout-ms', '120000', '--out', output, '--json']);
    const reduced = JSON.parse(command.stdout);
    assert.equal(reduced.stopReason, 'locally-minimal', JSON.stringify({ reason: reduced.reason, attemptFailure: reduced.attemptFailure }));
    assert.equal(command.status, 1); assert.equal(reduced.locallyMinimal, true); assert.equal(reduced.attemptFailure, undefined);
    assert(reduced.reducedChoices < reduced.originalChoices); assert.equal(reduced.originalChoices, 8);
    assert.deepEqual(reduced.run.failure, unsafe.run.failure); assert.equal(reduced.run.trace.length, 8); assert.equal(reduced.run.cleanup.complete, true);
    assert.deepEqual(parseRunArtifact(JSON.parse(await readFile(output, 'utf8'))), parseRunArtifact(reduced.run));
    assert.equal((await since(before)).names.length, reduced.attempts);
  });

  qualify('a changed helper is rejected before scenario import or database setup', async () => {
    assert(unsafe, 'Requires the recorded unsafe failure');
    const helper = join(app, 'connection.mjs'), original = await readFile(helper), before = await marks();
    try {
      await writeFile(helper, Buffer.concat([original, Buffer.from('\n// Source drift qualification.\n')]));
      const command = await execute([cli, 'replay', unsafe.file, unsafe.artifact, ...budget, '--json']);
      const drift = parseRunArtifact(JSON.parse(command.stdout));
      assert.equal(drift.outcome, 'incompatible', explain(drift)); assert.equal(command.status, 3);
      assert.match(drift.reason, /source/i); assert.deepEqual(drift.trace, []); assert.equal(drift.cleanup.complete, true);
      assert.deepEqual(await since(before), { names: [], imports: [], invariants: [] });
    } finally { await writeFile(helper, original); }
    assert((await readFile(helper)).equals(original));
  });

  qualify('original-archive export installs offline and replays the same failure exactly', async () => {
    assert(unsafe, 'Requires the recorded unsafe failure');
    const destination = join(evidence, 'portable');
    const command = await execute([cli, 'export', unsafe.file, unsafe.artifact, '--project-root', app,
      '--runtime-archive', process.env.INTERLEAVE_TYPEORM_RUNTIME_ARCHIVE, '--out', destination, '--json']);
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
    const replay = await execute([...args, ...budget, '--json'], destination);
    const replayed = parseRunArtifact(JSON.parse(replay.stdout));
    assert.equal(replayed.outcome, 'violation', explain(replayed)); assert.equal(replay.status, 1); assert.equal(replayed.mode, 'replay');
    assert.deepEqual(replayed.failure, unsafe.run.failure); assert.deepEqual(replayed.actors, unsafe.run.actors);
    assert.deepEqual(replayed.environment.source, unsafe.run.environment.source); assert.deepEqual(replayed.environment.fixture, unsafe.run.environment.fixture);
    assert.deepEqual(replayed.trace.map(step => step.fingerprint), unsafe.run.trace.map(step => step.fingerprint));
    assert.equal(replayed.cleanup.complete, true);
    const observed = await since(before);
    assert.equal(observed.names.length, 1); assert.deepEqual(events(observed), ['invoked', 'threw']);
  });
}

qualify('generated databases, backends and command processes are absent; the app lock is unchanged', async () => {
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
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ node: process.version, server, versions, portable,
    passed: cases.length > 0 && cases.every(item => item.status === 'passed'), cases, commands: commands.length }, null, 2) + '\n');
});
