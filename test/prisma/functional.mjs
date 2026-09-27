// Runs inside the separately installed consumer created by scripts/test-prisma.mjs,
// never in the repository's root dependency graph.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { explore, minimize, parseRunArtifact, replay, writeRunArtifact } from '@pavangupta352/interleave';

assert(['v22.18.0', 'v24.7.0'].includes(process.version), 'Prisma qualification requires Node.js 22.18.0 or 24.7.0');
const app = fileURLToPath(new URL('.', import.meta.url));
const evidence = process.env.INTERLEAVE_PRISMA_EVIDENCE, databaseUrl = process.env.TEST_DATABASE_URL;
const prismaCli = process.env.INTERLEAVE_PRISMA_CLI, runtimeArchive = process.env.INTERLEAVE_PRISMA_RUNTIME_ARCHIVE;
assert(evidence && databaseUrl && prismaCli && runtimeArchive, 'Run through scripts/test-prisma.mjs');
const installed = async name => JSON.parse(await readFile(join(app, 'node_modules', name, 'package.json'), 'utf8')).version;
const versions = { client: await installed('@prisma/client'), adapter: await installed('@prisma/adapter-pg'), pg: await installed('pg'),
  prisma: JSON.parse(await readFile(join(app, 'generator/node_modules/prisma/package.json'), 'utf8')).version,
  interleave: await installed('@pavangupta352/interleave') };
assert.deepEqual([versions.client, versions.adapter, versions.pg, versions.prisma], ['7.10.0', '7.10.0', '8.23.0', '7.10.0']);
const cli = join(app, 'node_modules/@pavangupta352/interleave/dist/cli.js');
// Journals written by the generated entry modules: import, setup and invariant calls.
const journals = { names: join(evidence, 'owned.txt'), imports: join(evidence, 'imports.txt'), invariants: join(evidence, 'invariants.jsonl') };
for (const file of Object.values(journals)) await writeFile(file, '', { flag: 'wx' });
Object.assign(process.env, { INTERLEAVE_PRISMA_NAMES: journals.names, INTERLEAVE_PRISMA_IMPORTS: journals.imports,
  INTERLEAVE_PRISMA_INVARIANTS: journals.invariants });
const lock = await readFile(join(app, 'package-lock.json'));
const budget = ['--timeout-ms', '30000'];
const include = ['--include', 'prisma'];
// An exhaustive search runs hundreds of schedules, each in a new worker with two
// Prisma clients and two source captures. Allow for a loaded host or CI runner;
// a budget stop still fails the check.
const searchBudget = ['--max-runs', '400', '--total-timeout-ms', '2700000'];
const searchProcessTimeout = 2_800_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
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
async function execute(args, { cwd = app, timeout = 240_000 } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
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
    steps: run.trace.map(step => [step.index, step.actor, step.sql.slice(0, 40), step.completion?.error?.code, step.completion?.transactionStatus]) });
}
// One generated entry per behavior. Journals are written only when their
// variables are set; the application scenario itself is unchanged. `observe`
// optionally replaces the actors with the same operation plus a final query.
async function entry(name, behavior, options = {}, observe) {
  const file = `${name}.mjs`;
  const source = `import { appendFile } from 'node:fs/promises';
import { createCheckoutScenario } from './scenario.ts';
${observe ? observe.imports : ''}
const journal = (name, line) => process.env[name] ? appendFile(process.env[name], line + '\\n') : undefined;
await journal('INTERLEAVE_PRISMA_IMPORTS', ${JSON.stringify(name)});
const scenario = createCheckoutScenario(${JSON.stringify(behavior)}, ${JSON.stringify(options)});
export default { ...scenario,${observe ? `\n  actors: ${observe.actors},` : ''}
  async setup(context) {
    await journal('INTERLEAVE_PRISMA_NAMES', new URL(context.connectionString).pathname.slice(1));
    await scenario.setup(context);
  },
  async invariant(context) {
    const note = event => journal('INTERLEAVE_PRISMA_INVARIANTS', JSON.stringify({ entry: ${JSON.stringify(name)},
      database: new URL(context.connectionString).pathname.slice(1), ...event }));
    await note({ event: 'invoked' });
    try { await scenario.invariant(context); }
    catch (error) { await note({ event: 'threw', name: error?.name, message: error?.message }); throw error; }
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
async function record(file, plan, { artifact, outcome, status, stopReason }) {
  artifact = join(evidence, artifact);
  const before = await marks();
  const schedule = plan.length ? ['--plan', plan.join(',')] : [];
  const command = await execute([cli, 'run', file, '--project-root', app, ...include, ...schedule, '--max-runs', '1', ...budget, '--out', artifact, '--json']);
  const run = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
  assert.equal(run.outcome, outcome, explain(run));
  assert.equal(command.status, status, explain(run));
  const search = JSON.parse(command.stdout);
  assert.equal(search.stopReason, stopReason); assert.equal(search.explored, 1);
  assert.deepEqual(parseRunArtifact(search.runs[0]), run);
  assert.deepEqual(run.plan, plan); assert.equal(run.cleanup.complete, true);
  assert.equal(run.environment.nodeVersion, process.version); server ??= run.environment.serverVersion;
  assert.equal(run.environment.serverVersion, server);
  const observed = await since(before);
  assert.equal(observed.names.length, 1); assert.deepEqual(observed.imports, [file.replace(/\.mjs$/, '')]);
  return { run, file, artifact, observed };
}
function qualify(name, body) {
  test(name, async () => {
    const item = { name, status: 'failed' }; cases.push(item);
    await body(); item.status = 'passed';
  });
}
const alternate = count => Array.from({ length: count }, () => ['alice', 'bob']).flat();
const events = observed => observed.invariants.map(item => item.event);
const actorSteps = (run, actor) => run.trace.filter(step => step.actor === actor);
const statement = step => step.sql.split(' ')[0];
// Every actor uses one PostgreSQL connection (generation 0) and one backend.
function oneConnection(run) {
  assert.deepEqual(run.connections.map(item => [item.actor, item.connection]), [['alice', 0], ['bob', 0]]);
  for (const actor of ['alice', 'bob']) assert.equal(new Set(actorSteps(run, actor).map(step => `${step.connection}:${step.backendPid}`)).size, 1);
}
const replayMatches = (repeated, original) => {
  assert.deepEqual(repeated.failure, original.failure); assert.deepEqual(repeated.actors, original.actors);
  assert.deepEqual(repeated.environment.source, original.environment.source); assert.deepEqual(repeated.environment.fixture, original.environment.fixture);
  assert.deepEqual(repeated.trace.map(step => step.fingerprint), original.trace.map(step => step.fingerprint));
  assert.equal(repeated.cleanup.complete, true);
};
async function exact(file, artifact, expected) {
  const before = await marks();
  const command = await execute([cli, 'replay', file, artifact, ...budget, '--json']);
  const repeated = parseRunArtifact(JSON.parse(command.stdout));
  assert.equal(repeated.mode, 'replay');
  return { command, repeated, observed: await since(before), expected };
}
async function rejectedBeforeImport(file, artifact) {
  const before = await marks();
  const command = await execute([cli, 'replay', file, artifact, ...budget, '--json']);
  const drift = parseRunArtifact(JSON.parse(command.stdout));
  assert.equal(drift.outcome, 'incompatible', explain(drift)); assert.equal(command.status, 3);
  assert.equal(drift.reason, 'Replay source, installed dependencies or Interleave runtime identity changed');
  assert.deepEqual(drift.trace, []); assert.equal(drift.cleanup.complete, true);
  assert.deepEqual(await since(before), { names: [], imports: [], invariants: [] });
  return drift;
}
async function generate() {
  const command = await execute([prismaCli, 'generate'], { cwd: join(app, 'generator') });
  assert.equal(command.status, 0, command.stderr);
}
async function generated(run) {
  const files = run.environment.source.components.source.files.filter(file => file.path.startsWith('generated/prisma/'));
  return Promise.all(files.map(async file => ({ ...file, actual: sha256(await readFile(join(app, file.path))) })));
}
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const unsafeOrder = ['alice', 'bob', 'alice', 'bob', 'alice', 'bob', 'alice', 'bob', 'alice', 'bob'];

qualify('an unsafe Prisma checkout oversells through the generated client, and exact replay repeats it', async () => {
  unsafe = await record(await entry('checkout', 'checkout'), alternate(2), { artifact: 'checkout.json', outcome: 'violation', status: 1, stopReason: 'failure' });
  const { run, observed } = unsafe;
  assert.equal(run.failure.message, 'Accepted orders exceed the available stock');
  assert.deepEqual(events(observed), ['invoked', 'threw']);
  assert.deepEqual(run.actors.map(actor => actor.value), Array(2).fill({ status: 'ordered', attempts: 1, retried: [] }));
  // Prisma sends BEGIN/COMMIT as simple queries and model operations as
  // parameterized extended-protocol cycles. Both actors read the last unit.
  assert.deepEqual(run.trace.map(step => [step.actor, statement(step), step.protocol]), [
    ['alice', 'BEGIN', 'simple'], ['bob', 'BEGIN', 'simple'], ['alice', 'SELECT', 'extended'], ['bob', 'SELECT', 'extended'],
    ['alice', 'INSERT', 'extended'], ['bob', 'INSERT', 'extended'], ['alice', 'UPDATE', 'extended'], ['bob', 'UPDATE', 'extended'],
    ['alice', 'COMMIT', 'simple'], ['bob', 'COMMIT', 'simple']]);
  for (const step of run.trace.filter(step => step.protocol === 'extended')) assert.match(step.sql, /\$1/);
  assert.match(run.trace[6].sql, /^UPDATE "public"\."products" SET "stock" = \$1 WHERE/);
  // Bob's UPDATE waited for the row lock held by alice's open transaction.
  assert(run.trace[7].waits.some(wait => wait.waitEventType === 'Lock' && wait.blockerPids.includes(run.trace[6].backendPid)), JSON.stringify(run.trace[7].waits));
  assert(run.trace.every(step => !step.completion.error)); oneConnection(run);
  // The generated client, schema and migration are recorded source inputs.
  const source = run.environment.source;
  const paths = source.components.source.files.map(file => file.path);
  for (const path of ['generated/prisma/client.ts', 'generated/prisma/internal/class.ts', 'generated/prisma/internal/prismaNamespace.ts',
    'generated/prisma/enums.ts', 'prisma/schema.prisma', 'prisma/migrations/0_init/migration.sql', 'scenario.ts', 'src/checkout.ts', 'src/db.ts']) {
    assert(paths.includes(path), path);
  }
  for (const file of await generated(run)) assert.equal(file.actual, file.sha256, file.path);
  const packages = source.components.dependencies.packages;
  for (const [name, version] of [['@prisma/client', '7.10.0'], ['@prisma/adapter-pg', '7.10.0'], ['pg', '8.23.0']]) {
    assert(packages.some(item => item.name === name && item.version === version && item.fileCount > 0), name);
  }
  // The CLI and TypeScript peers are not installed in the application.
  const client = packages.find(item => item.name === '@prisma/client');
  assert.deepEqual(client.dependencies.filter(edge => edge.missing).map(edge => edge.name).sort(), ['prisma', 'typescript']);
  assert(!packages.some(item => ['prisma', '@prisma/engines', 'typescript'].includes(item.name)));
  assert(client.byteCount > 64 * 1024 * 1024 && source.byteCount <= 128 * 1024 * 1024, JSON.stringify([client.byteCount, source.byteCount]));
  await writeFile(join(evidence, 'identity.json'), JSON.stringify({ byteCount: source.byteCount, fileCount: source.fileCount,
    client: { byteCount: client.byteCount, fileCount: client.fileCount }, packages: packages.length, sourceFiles: paths }, null, 2) + '\n');

  const { command, repeated, observed: again } = await exact(unsafe.file, unsafe.artifact);
  assert.equal(repeated.outcome, 'violation', explain(repeated)); assert.equal(command.status, 1);
  replayMatches(repeated, run); assert.deepEqual(events(again), ['invoked', 'threw']);
});

qualify('the library API explores, replays and minimizes the same Prisma checkout', async () => {
  const file = join(app, await entry('checkout-api', 'checkout'));
  const options = { databaseUrl, timeoutMs: 30_000, source: { projectRoot: app, include: ['prisma'] } };
  const before = await marks();
  const search = await explore(file, { ...options, maxRuns: 20 });
  assert.equal(search.stopReason, 'failure'); assert.equal(search.firstFailure?.outcome, 'violation');
  const found = search.firstFailure;
  assert.equal(found.failure.message, 'Accepted orders exceed the available stock'); assert.equal(found.cleanup.complete, true);
  await writeRunArtifact(join(evidence, 'api-failure.json'), found);
  const repeated = await replay(file, found, options);
  assert.equal(repeated.outcome, 'violation', explain(repeated)); assert.equal(repeated.mode, 'replay'); replayMatches(repeated, found);
  const reduced = await minimize(file, found, { ...options, maxAttempts: 16, totalTimeoutMs: 120_000 });
  assert.equal(reduced.stopReason, 'locally-minimal', JSON.stringify({ reason: reduced.reason, attemptFailure: reduced.attemptFailure }));
  assert.deepEqual(reduced.run.failure, found.failure); assert.equal(reduced.run.cleanup.complete, true);
  await writeRunArtifact(join(evidence, 'api-minimal.json'), reduced.run);
  const observed = await since(before);
  assert.equal(observed.names.length, search.explored + 1 + reduced.attempts);
  await writeFile(join(evidence, 'api-summary.json'), JSON.stringify({ explored: search.explored, metrics: search.metrics,
    reduction: { attempts: reduced.attempts, originalChoices: reduced.originalChoices, reducedChoices: reduced.reducedChoices } }, null, 2) + '\n');
});

qualify('CLI minimization keeps the same Prisma oversell', async () => {
  assert(unsafe, 'Requires the recorded unsafe checkout');
  const before = await marks(), output = join(evidence, 'checkout-minimal.json');
  const command = await execute([cli, 'minimize', unsafe.file, unsafe.artifact, ...budget, '--max-attempts', '16', '--total-timeout-ms', '120000', '--out', output, '--json']);
  const reduced = JSON.parse(command.stdout);
  assert.equal(reduced.stopReason, 'locally-minimal', JSON.stringify({ reason: reduced.reason, attemptFailure: reduced.attemptFailure }));
  assert.equal(command.status, 1); assert.equal(reduced.locallyMinimal, true); assert.equal(reduced.attemptFailure, undefined);
  // Reduction starts from the recorded execution order, not only the explicit plan prefix.
  assert(reduced.reducedChoices < reduced.originalChoices); assert.equal(reduced.originalChoices, unsafe.run.trace.length);
  assert.deepEqual(reduced.run.failure, unsafe.run.failure); assert.equal(reduced.run.trace.length, 10); assert.equal(reduced.run.cleanup.complete, true);
  assert.deepEqual(parseRunArtifact(JSON.parse(await readFile(output, 'utf8'))), parseRunArtifact(reduced.run));
  assert.equal((await since(before)).names.length, reduced.attempts);
});

qualify('an edited generated client is rejected before scenario import or database setup', async () => {
  assert(unsafe, 'Requires the recorded unsafe checkout');
  const path = join(app, 'generated/prisma/internal/class.ts'), original = await readFile(path);
  try {
    await writeFile(path, Buffer.concat([original, Buffer.from('\n// Generated-client drift qualification.\n')]));
    await rejectedBeforeImport(unsafe.file, unsafe.artifact);
  } finally { await writeFile(path, original); }
  assert((await readFile(path)).equals(original));
});

qualify('a schema change regenerates a different client that exact replay rejects; regeneration restores identical bytes', async () => {
  assert(unsafe, 'Requires the recorded unsafe checkout');
  const schema = join(app, 'prisma/schema.prisma'), original = await readFile(schema, 'utf8');
  const changed = original.replace('  stock  Int\n', '  stock  Int\n  sku    String?\n');
  assert.notEqual(changed, original);
  try {
    await writeFile(schema, changed); await generate();
    const differing = (await generated(unsafe.run)).filter(file => file.actual !== file.sha256).map(file => file.path);
    assert(differing.includes('generated/prisma/internal/class.ts'), JSON.stringify(differing));
    await writeFile(join(evidence, 'schema-change.json'), JSON.stringify({ differing }, null, 2) + '\n');
    await rejectedBeforeImport(unsafe.file, unsafe.artifact);
  } finally { await writeFile(schema, original); await generate(); }
  for (const file of await generated(unsafe.run)) assert.equal(file.actual, file.sha256, `${file.path} was not regenerated identically`);
  const { command, repeated } = await exact(unsafe.file, unsafe.artifact);
  assert.equal(repeated.outcome, 'violation', explain(repeated)); assert.equal(command.status, 1); replayMatches(repeated, unsafe.run);
});

qualify('shared export stops at the 16 MiB per-archive bound without creating a bundle', async () => {
  assert(unsafe, 'Requires the recorded unsafe checkout');
  const destination = join(evidence, 'portable');
  const command = await execute([cli, 'export', unsafe.file, unsafe.artifact, '--project-root', app, '--runtime-archive', runtimeArchive, '--out', destination, '--json']);
  assert.equal(command.status, 2);
  assert.deepEqual(JSON.parse(command.stdout), { error: { message: 'Archive download exceeds 16 MiB' }, exitCode: 2 });
  assert.equal(await exists(destination), false);
});

qualify('serializable purchases: PostgreSQL rejects the overlap with 40001, the order rolls back and the purchase retries', async () => {
  const { run, observed } = await record(await entry('serializable-retry', 'serializable-retry'), alternate(5),
    { artifact: 'serializable-retry.json', outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert.deepEqual(events(observed), ['invoked', 'returned']); oneConnection(run);
  assert.deepEqual(run.actors.map(actor => actor.value), [{ status: 'ordered', attempts: 1, retried: [] },
    { status: 'sold-out', attempts: 2, retried: ['P2034'] }]);
  const failed = run.trace.filter(step => step.completion?.error);
  assert.equal(failed.length, 1, explain(run));
  const [conflict] = failed, alice = actorSteps(run, 'alice');
  assert.equal(conflict.actor, 'bob'); assert.equal(statement(conflict), 'UPDATE');
  assert.equal(conflict.completion.error.code, '40001'); assert.equal(conflict.completion.transactionStatus, 'E');
  assert(conflict.waits.some(wait => wait.waitEventType === 'Lock' && wait.blockerPids.includes(alice[0].backendPid)), JSON.stringify(conflict.waits));
  assert(alice.find(step => step.sql === 'COMMIT').index > conflict.index);
  const later = actorSteps(run, 'bob').filter(step => step.index > conflict.index).map(step => step.sql.startsWith('SELECT COUNT') ? 'COUNT' : statement(step));
  assert.deepEqual(later, ['ROLLBACK', 'COUNT', 'BEGIN', 'SET', 'SELECT', 'COMMIT']);
  assert(actorSteps(run, 'bob').some(step => step.sql === 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'));
});

qualify('serializable purchases without retry: P2034 rejects the actor and the invariant is not evaluated', async () => {
  const { run, observed } = await record(await entry('serializable-no-retry', 'serializable-no-retry'), alternate(5),
    { artifact: 'serializable-no-retry.json', outcome: 'actor-error', status: 2, stopReason: 'inconclusive' });
  assert.equal(run.reason, 'One or more application operations rejected; the invariant was not evaluated');
  assert.deepEqual(observed.invariants, []); assert.equal(run.failure, undefined);
  assert.deepEqual(run.actors[0], { actor: 'alice', status: 'fulfilled', value: { status: 'ordered', attempts: 1, retried: [] } });
  assert.equal(run.actors[1].status, 'rejected'); assert.match(run.actors[1].error, /write conflict or a deadlock/);
  const failed = run.trace.filter(step => step.completion?.error);
  assert.deepEqual(failed.map(step => [step.actor, statement(step), step.completion.error.code]), [['bob', 'UPDATE', '40001']]);
  assert.deepEqual(actorSteps(run, 'bob').filter(step => step.index > failed[0].index).map(step => [step.sql, step.completion.transactionStatus]), [['ROLLBACK', 'I']]);
});

qualify('a duplicate order fails with 23505, its transaction rolls back, and CRUD continues on the same connection', async () => {
  const { run, observed } = await record(await entry('order-lifecycle', 'order-lifecycle'), [],
    { artifact: 'order-lifecycle.json', outcome: 'passed', status: 4, stopReason: 'max-runs' });
  assert.deepEqual(events(observed), ['invoked', 'returned']); oneConnection(run);
  for (const actor of ['alice', 'bob']) {
    const steps = actorSteps(run, actor);
    assert.deepEqual(steps.map(step => step.sql.startsWith('SELECT COUNT') ? 'COUNT' : statement(step)),
      ['BEGIN', 'INSERT', 'INSERT', 'ROLLBACK', 'COUNT', 'INSERT', 'UPDATE', 'SELECT', 'DELETE']);
    assert.deepEqual(steps.filter(step => step.completion.error).map(step => [step.index, step.completion.error.code, step.completion.transactionStatus]),
      [[steps[2].index, '23505', 'E']]);
    assert.equal(steps[3].completion.transactionStatus, 'I');
    assert(steps.slice(4).every(step => step.protocol === 'extended' && step.completion.transactionStatus === 'I'));
  }
});

qualify('named prepared statements are created once per connection, reused after a rollback, and replay exactly', async () => {
  // The same compare-and-set purchase, followed by a query of the session's
  // prepared statements before the actor's client disconnects.
  const file = await entry('compare-and-set-prepared', 'compare-and-set', { preparedStatements: true }, {
    imports: "import { withPrisma } from './src/db.ts';\nimport { compareAndSet } from './src/purchases.ts';\n",
    actors: `Object.fromEntries(['alice', 'bob'].map(name => [name, context => withPrisma(context, async prisma => {
    const result = await compareAndSet(prisma, 1, context.actor);
    const statements = await prisma.$queryRaw\`SELECT name, statement FROM pg_prepared_statements ORDER BY statement\`;
    return { ...result, statements: statements.map(({ name, statement }) => ({ name, statement })) };
  }, { preparedStatements: true })]))`,
  });
  const { run, artifact } = await record(file, unsafeOrder, { artifact: 'compare-and-set-prepared.json', outcome: 'passed', status: 4, stopReason: 'max-runs' });
  const [alice, bob] = run.actors.map(actor => actor.value);
  assert.deepEqual([alice, bob].map(({ statements: _statements, ...value }) => value), [{ status: 'ordered', attempts: 1, retried: [] },
    { status: 'sold-out', attempts: 2, retried: ['stock-changed'] }]);
  // With a statement name, node-postgres sends even BEGIN through the extended protocol.
  assert(run.trace.every(step => step.protocol === 'extended'), explain(run));
  const executed = actor => [...new Set(actorSteps(run, actor).map(step => step.sql))].sort();
  for (const [actor, value] of [['alice', alice], ['bob', bob]]) {
    // One named statement per distinct SQL text, including the observation query.
    assert.deepEqual(value.statements.map(item => item.statement).sort(), executed(actor), actor);
    assert(value.statements.every(item => /^prisma_[a-f0-9]{24}$/.test(item.name)), actor);
  }
  // Bob ran BEGIN and the product SELECT twice. PostgreSQL keeps a named
  // statement for the session and rejects a second Parse of the same name
  // (42P05), so his retry completed by binding the statements parsed before
  // the rollback.
  const steps = actorSteps(run, 'bob');
  for (const sql of ['BEGIN', steps.find(step => statement(step) === 'SELECT').sql]) {
    const uses = steps.filter(step => step.sql === sql);
    assert.equal(uses.length, 2, sql); assert(uses.every(step => !step.completion.error), sql);
    assert.equal(bob.statements.filter(item => item.statement === sql).length, 1, sql);
  }
  const { command, repeated } = await exact(file, artifact);
  assert.equal(repeated.outcome, 'passed', explain(repeated)); assert.equal(command.status, 0); replayMatches(repeated, run);
});

qualify('the conditional-decrement repair explores its full frontier without violations; the unsafe order is not followable', async () => {
  assert(unsafe, 'Requires the recorded unsafe checkout');
  const file = await entry('conditional-decrement', 'conditional-decrement');
  const before = await marks();
  const command = await execute([cli, 'run', file, '--project-root', app, ...include, ...searchBudget, ...budget, '--json'], { timeout: searchProcessTimeout });
  const search = JSON.parse(command.stdout);
  assert.equal(command.status, 0, command.stdout.slice(0, 2000));
  assert.equal(search.stopReason, 'frontier-exhausted'); assert.equal(search.pending, 0); assert.equal(search.violationCount, 0);
  assert.equal(search.hardFailureCount, 0); assert(search.runs.every(run => run.outcome === 'passed' && run.cleanup.complete));
  assert.equal((await since(before)).names.length, search.explored);
  await writeFile(join(evidence, 'conditional-decrement-search.json'), JSON.stringify({ explored: search.explored, metrics: search.metrics, stopReason: search.stopReason }, null, 2) + '\n');
  const guided = await execute([cli, 'replay', file, unsafe.artifact, '--guided', ...budget, '--json']);
  const attempt = parseRunArtifact(JSON.parse(guided.stdout));
  assert.equal(attempt.mode, 'guided'); assert.equal(attempt.outcome, 'incompatible', explain(attempt)); assert.equal(guided.status, 3);
  assert.match(attempt.reason, /^Schedule asks for bob, which cannot issue its next query at step \d+$/);
});

qualify('after repairing the checkout, exact replay is rejected, the guided rerun passes and fresh exploration exhausts its frontier', async () => {
  assert(unsafe, 'Requires the recorded unsafe checkout');
  const path = join(app, 'src/checkout.ts'), original = await readFile(path, 'utf8');
  const repaired = original.replaceAll('readThenWrite', 'compareAndSet');
  assert.equal(original.split('readThenWrite').length, 3);
  try {
    await writeFile(path, repaired);
    await rejectedBeforeImport(unsafe.file, unsafe.artifact);
    const before = await marks();
    const guided = await execute([cli, 'replay', unsafe.file, unsafe.artifact, '--guided', '--out', join(evidence, 'repaired-guided.json'), ...budget, '--json']);
    const rerun = parseRunArtifact(JSON.parse(guided.stdout));
    assert.equal(rerun.mode, 'guided'); assert.equal(rerun.outcome, 'passed', explain(rerun)); assert.equal(guided.status, 0);
    assert.deepEqual(rerun.plan, unsafe.run.trace.map(step => step.actor));
    assert.notEqual(rerun.environment.source.fingerprint, unsafe.run.environment.source.fingerprint);
    assert.deepEqual(events(await since(before)), ['invoked', 'returned']);
    assert.deepEqual(rerun.actors.map(actor => actor.value), [{ status: 'ordered', attempts: 1, retried: [] },
      { status: 'sold-out', attempts: 2, retried: ['stock-changed'] }]);
    // Bob's compare-and-set waited for alice, matched no row and rolled back his order.
    const bob = actorSteps(rerun, 'bob');
    assert.deepEqual(bob.map(step => statement(step)), ['BEGIN', 'SELECT', 'INSERT', 'UPDATE', 'ROLLBACK', 'BEGIN', 'SELECT', 'COMMIT']);
    assert(bob[3].waits.some(wait => wait.waitEventType === 'Lock'), JSON.stringify(bob[3].waits));
    // Without statement names, both reads are identical unnamed extended cycles.
    assert.equal(bob[1].fingerprint, bob[6].fingerprint);
    const search = await execute([cli, 'run', unsafe.file, '--project-root', app, ...include, ...searchBudget, ...budget, '--json'], { timeout: searchProcessTimeout });
    const summary = JSON.parse(search.stdout);
    assert.equal(search.status, 0, search.stdout.slice(0, 2000));
    assert.equal(summary.stopReason, 'frontier-exhausted'); assert.equal(summary.pending, 0); assert.equal(summary.violationCount, 0);
    assert.equal(summary.hardFailureCount, 0); assert(summary.runs.every(run => run.outcome === 'passed' && run.cleanup.complete));
    await writeFile(join(evidence, 'repaired-search.json'), JSON.stringify({ explored: summary.explored, metrics: summary.metrics, stopReason: summary.stopReason }, null, 2) + '\n');
  } finally { await writeFile(path, original); }
  assert.equal(await readFile(path, 'utf8'), original);
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
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ node: process.version, server, versions,
    passed: cases.length > 0 && cases.every(item => item.status === 'passed'), cases, commands: commands.length }, null, 2) + '\n');
});
