# Library API

This page describes the 0.1 API. Before 1.0, a minor release may change it; the [changelog](../CHANGELOG.md) records every change and the [compatibility guide](compatibility.md) lists what each release was qualified against.

For a complete application example, start with the [application guide](application-guide.md).
The [CI guide](ci.md) shows result checks and evidence retention. The API requires
an explicit dedicated `databaseUrl`; managed `--docker` is a CLI option.

## Define a scenario

`defineScenario` validates a name, setup function, two to eight named actors, and an invariant. Setup and the invariant receive a direct connection to a fresh database. Each actor receives its own proxy URL and cancellation signal.

```js
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { defineScenario } from '@pavangupta352/interleave';

export default defineScenario({
  name: 'two-increments',
  async setup({ db }) {
    await db.query('CREATE TABLE counter (n int); INSERT INTO counter VALUES (0)');
  },
  actors: { alice: increment, bob: increment },
  async invariant({ db }) {
    assert.equal((await db.query('SELECT n FROM counter')).rows[0].n, 2);
  },
});

async function increment({ connectionString }) {
  const db = new Client({ connectionString });
  await db.connect();
  try {
    const { rows } = await db.query('SELECT n FROM counter');
    await db.query('UPDATE counter SET n = $1', [rows[0].n + 1]);
  } finally {
    await db.end();
  }
}
```

Each actor defaults to one admitted PostgreSQL connection. Set `maxConnectionsPerActor` from 2 through 8 to permit queryless auxiliary connections, such as an adapter monitor. Only one live connection may issue commands; it keeps that role until it closes, including while idle. Another live connection sending commands is an unsupported profile. Sequential reconnects receive a new connection generation. An operation that runs queries concurrently through a pool needs the explicit [multi-connection profile](#multi-connection-actors).

A client can finish closing before the proxy receives both socket-close notifications. During confirmed shutdown, one prospective TCP client may wait with bounded, uninterpreted data. It receives no connection generation or startup identity, and opens no upstream connection, until the old frontend and backend sockets have both closed. A disconnected waiting client is discarded. Further waiting clients and connections beyond the cap while existing sessions are live remain unsupported.

Return a JSON value only when that observation belongs in the recorded evidence. An assertion failure in the invariant produces a violation; another exception is a harness error. Rejected application operations are actor errors and do not count as invariant violations.

## External programs as actors

`processActor(command, args?, options?)` turns any program into an actor, whatever
language or PostgreSQL client it uses:

```js
import { defineScenario, processActor } from '@pavangupta352/interleave';

const checkout = processActor('python3', ['checkout.py'], { cwd: 'services/shop' });
export default defineScenario({ name: 'last-unit', setup, actors: { alice: checkout, bob: checkout }, invariant });
```

The program receives only its actor endpoint: `DATABASE_URL`, and `PGHOST`, `PGPORT`,
`PGDATABASE`, `PGUSER`, `PGPASSWORD` with `PGSSLMODE=disable` for libpq-based
clients. Other inherited `PG*` settings are removed. `INTERLEAVE_ACTOR` names the
actor. Pass `env` as an object, or a function of the actor context, to map the
endpoint to your application's own variable names.

stdout is the result channel: empty, or exactly one JSON document, which becomes
the actor's recorded value. Write logs to stderr. Use `output: 'ignore'` for
programs that print other text. A nonzero exit rejects the actor with its status
and the last 2 KiB of stderr, with the endpoint password redacted. Cancellation
sends SIGTERM, then SIGKILL after `killGraceMs` (default 1000). stdout is bounded
by `maxOutputBytes` (default 1 MiB). The program must not daemonize; it runs in
the actor's process tree and is stopped with the run.

Every connection the program opens goes through its actor's proxy, so the usual
limits apply: one live command-producing connection per actor, and the qualified
protocol subset. Bind program files into file recordings with `--include` (or
`source.include`) so that editing them makes exact replay incompatible. The
interpreter, runtime and packages the program loads are not part of Interleave's
identity: pin them and replay in the same environment.

## Run and search

`runScenarioFile(file, options)` imports an explicitly selected, trusted local scenario in a disposable worker. Its parent owns database cleanup even if the worker exits or crashes. Prefer file targets for the complete workflow:

```js
import { explore, minimize, writeRunArtifact } from '@pavangupta352/interleave';

const options = { databaseUrl: process.env.TEST_DATABASE_URL };
const search = await explore('./scenario.mjs', { ...options, maxRuns: 50 });
if (search.firstFailure) {
  const reduced = await minimize('./scenario.mjs', search.firstFailure, options);
  await writeRunArtifact('./failure.interleave.json', reduced.run);
}
```

Minimization performs its own exact verification of the original failure and
requires the same invariant fingerprint. Passing a newly observed replay result
as the baseline could select a different outcome or failure. Inspect the search
and reduction stop reasons, cleanup and `attemptFailure` before deciding the
whole workflow completed; the [CI example](ci.md#check-the-repaired-operation-with-the-node-test-runner)
shows explicit acceptance checks.

`explore`, `replay`, and `minimize` also accept a scenario object. Object targets run in the caller's process through `runOnce`. The caller must own its application's process and client lifecycles; a JavaScript callback that blocks the event loop cannot be interrupted there. File targets keep worker supervision for every search, replay, and reduction attempt.

Supervision is a lifecycle boundary for trusted code. On POSIX it terminates the worker's process group; on Windows it terminates the worker. Application-created detached processes remain the scenario's responsibility. `cleanup.complete` reports the owned database and harness resources, and failed creation recovery retains the generated database name. It is not a sandbox or a guarantee about arbitrary external effects.

If the server's database-creation acknowledgement is lost, ownership and cleanup
remain unknown. The failure retains the exact generated database name and marks
cleanup incomplete. Interleave does not drop an unconfirmed name, since it cannot
distinguish its own creation from a pre-existing collision. Inspect that named
database on the dedicated test server before deciding how to recover it.
The qualified driver exposes the server's localized error severity. If that
severity is not recognizable as a definite statement rejection, Interleave
conservatively retains unknown cleanup, even when the server may have rejected
the creation.

## Verified upstream TLS

```ts
const options = {
  databaseUrl: process.env.TEST_DATABASE_URL!, // host must match the server certificate
  upstreamTls: { mode: 'verify-full', ca: await readFile('test-ca.pem', 'utf8') },
};
```

`upstreamTls` verifies the server certificate chain and the URL hostname or IP
address for every connection Interleave opens, including actor proxy upstream
sessions and cleanup. `ca` is optional PEM text that replaces Node.js's bundled
roots. `sslmode=verify-full` in the URL is equivalent without `ca`; combining it
with `upstreamTls`, or using another TLS URL option, is rejected before any
connection. Actors keep receiving a loopback plaintext `connectionString`.

Setup and invariant contexts include `connectionOptions`, a fresh node-postgres
configuration for the generated database. Use it for additional clients:
`new Client(context.connectionOptions)`. It carries the in-memory CA, which a URL
cannot. `context.connectionString` always states the selection explicitly:
`sslmode=verify-full` for TLS runs and `sslmode=disable` for plaintext ones.
URL-configured drivers then verify with their own TLS settings (for Node.js
drivers, its default roots); with a private CA, use `connectionOptions` or give
that driver its own CA setting. Actor endpoints always carry `sslmode=disable`;
node-postgres gives that URL setting precedence over a client's `ssl` option, so
actor code written for TLS in production still connects to its loopback endpoint.

Every new run records `environment.transport`: the actor endpoint profile, the
authentication boundary and the upstream policy. For TLS that includes the
trust source, a fingerprint of the trusted CA set and a fingerprint of the
verified host name. It never contains CA contents, file paths or credentials.
Exact replay and reduction compare it before creating a database.

## Protocol profiles

The default `protocolProfile: 'sync-cycle-v1'` schedules one Simple Query packet or one complete extended cycle ending in Sync. Select `protocolProfile: 'describe-flush-v1'` for the qualified Postgres.js flow that needs server metadata before sending parameter values.

The staged profile gives Parse/statement Describe/Flush its own release gate. Real metadata completes that stage; matching Bind/Execute/Sync requires a second release. A Parse error instead requires a separately released Sync recovery. Cached prepared queries and ordinary whole cycles remain single stages. Each release counts toward `maxSteps`, including metadata and recovery.

Use Postgres.js 3.4.9 with `max: 1`, `ssl: false`, and prompt client closure on the actor's AbortSignal as well as in `finally`. Interrupted `sql.begin` calls need this lifecycle because the driver waits for ReadyForQuery before settling a protocol error. See the [measured profile and complete lifecycle example](qualification/postgresjs-describe-flush-2026-09-09.md). Selecting the profile does not enable arbitrary early-Flush pipelines, cursors, COPY, or cancellation routing.

## Multi-connection actors

```js
const options = { databaseUrl: process.env.TEST_DATABASE_URL, connectionProfile: 'multi-producer-v1' };
const run = await runScenarioFile('./scenario.mjs', { ...options, plan: ['alice#0', 'alice#1', 'bob'] });
```

`connectionProfile: 'multi-producer-v1'` lets every admitted connection of an
actor send commands, for example a `pg.Pool` serving `Promise.all` queries, or an
ORM transaction plus a query issued through the outer pool. Each connection is a
**lane**, written `alice#1`: the actor and its zero-based connection generation,
assigned in accept order. `maxConnectionsPerActor` defaults to 8 in this profile
and remains the cap; size the application's pool within it.

Every lane releases its own units in order, one at a time. The global rule is
unchanged: another unit is released only when every running unit, on any lane,
has completed or is confirmed blocked by a PostgreSQL lock observation. Lanes of
one actor can therefore wait for each other; the observed wait identifies the
blocking connection's backend. An actor is ready for the next decision once it has settled or
any of its lanes has a queued or running unit; idle connections are not waited
for. A connection that has just started or completed a command gets up to 25 ms
to queue its next one before the scheduler decides without it. A command that
arrives later is not an available choice at that decision, so fair fallback and
recorded choices can still differ between runs when application timing varies.

A plan entry `alice` releases whichever of alice's connections can proceed,
rotating among them. `alice#1` names one connection. If it has not queued its
next command yet, the runner waits for it. The choice is infeasible and the run
is `incompatible`, naming the connection, if alice settles first, if that
connection is closed or lock-blocked, or if nothing else can proceed for half of
`timeoutMs` (at most 5 seconds), for example because the connection is waiting
for a result the plan holds back. Exploration and reduction move on from such a
choice. It is never a pass. Exploration,
guided replay and reduction qualify only the actors that used several command
connections, so single-connection actors keep plain names. A lane number in a
plan refers to the accept order of the run executing it; connections opened
concurrently can be numbered differently in another run.

Exact replay does not rely on accept order. It binds each recorded connection to
a live connection when the recorded connection's first command is due: the live
connection must have the same startup identity and a queued command identical to
the recorded one (protocol, SQL, fingerprint and stage). The recorded generation
is preferred; another connection is used when the sockets arrived in a different
order. A binding never changes during the run, and startup counts, waits and
transaction states are compared through it. A queued command that no recorded
connection can match is `incompatible` immediately. When several connections of
one actor begin with the same command and later diverge, their queued commands
cannot distinguish them. Replay prefers the recorded connection while it may
still queue that command, and binds another matching connection once nothing
has proceeded for the same bounded wait. If that guess or a changed accept order
does not match the recording, replay reports `incompatible`, never a false match.

Records of this profile use schema version 4. The default `single-producer-v1`
profile, its records and its rejection of a second command connection are
unchanged; that error now names this profile as the alternative.
Exact replay, guided replay and reduction inherit the recorded profile; selecting
a different one for exact replay is `incompatible` before any database work. The
profile combines with `describe-flush-v1`: each Postgres.js connection keeps its
own metadata and execution stages.

## Statement overlap

```js
const search = await explore(scenario, { databaseUrl: process.env.TEST_DATABASE_URL, overlap: 'pairs' });
const first = await runOnce(scenario, { databaseUrl: process.env.TEST_DATABASE_URL, overlap: 'pairs', plan: ['alice+bob'] });
```

By default a unit is released only when every running unit has completed or is
confirmed blocked on a lock, so exploration covers orders *between* statements.
Some races live *inside* one statement's execution: `INSERT ... WHERE NOT
EXISTS` without a unique constraint, an upsert emulated in a CTE, or a read and a
write in one statement. They need two statements running at once, which
one-at-a-time release never produces.

`overlap: 'pairs'` adds a second kind of choice: release the next units of two
available actors, or two lanes, together. Both are written to PostgreSQL in one
synchronous pass; PostgreSQL decides how their execution interleaves, and each
completion and lock wait is observed as usual. The plan entry `alice+bob` asks for
that pair, `alice#0+alice#1` pairs two lanes of one multi-producer actor, and
exploration offers every unordered pair of available entries as an alternative
at each decision. Fair fallback never pairs, so a run without pair entries still
releases one unit at a time. Reduction treats a pair as one choice.

Both steps of a pair record `overlap`, the index of the pair's first step, with
one release time and one list of available entries. Runs with overlap use schema
version 4, with `limits.overlap: 'pairs'` and an explicit `limits.connectionProfile`
even when it is `single-producer-v1`.

Exact replay, guided replay and reduction inherit the recorded mode; asking exact
replay for a different one is `incompatible` before any database work. Replay
releases a recorded pair together again and checks each command's identity, but
it cannot make PostgreSQL interleave the pair the same way. It therefore does not
compare lock waits or transaction states inside a pair, and the invariant result
can differ from the recording. Replay an overlap failure several times before
relying on it in CI, and read a mismatch after a pair as a changed interleaving:
such an `incompatible` reason says so.

## File identity

Before importing a scenario, the supervisor captures its literal local module graph, controlling package metadata and lockfile, actual installed dependency files and declared dependency relationships, and the Interleave runtime. It checks the same inputs after execution. Changed files prevent a completed result from being presented as bound evidence. Source and compiled runtimes have different identities.

The root defaults to the nearest ancestor with a `package.json`, or the entry directory when none exists. Declare other files read by the application explicitly:

```js
const options = {
  databaseUrl: process.env.TEST_DATABASE_URL,
  source: { projectRoot: '/path/to/application', include: ['fixtures', 'migrations'] },
};
```

Paths in the artifact are relative to that root. Replay can relocate the project while preserving the same source, installed package instances and runtime; it derives the root from the recorded entry path. The manifest includes file lengths and hashes, not file contents. Its default capture bounds are 10,000 files, 64 MiB total and 16 MiB per file, within the execution deadline and evidence budget.

This profile supports ordinary Node resolution with literal imports. Unsupported custom loaders, computed imports, package aliases, application native addons and symbolic links fail explicitly. It does not freeze the filesystem or capture arbitrary environment variables, clocks, randomness, network responses, or undeclared external files. Declare data inputs and arrange deterministic application inputs in the scenario.

An in-process scenario object cannot attest the files or closure state already loaded by its caller. Its record has no file identity. Legacy file records remain readable, but need a guided run to create new bound evidence before exact file replay. A repaired file target also needs a guided run or fresh exploration, even when its SQL is unchanged.

## Budgets and outcomes

Run options require `databaseUrl`, an explicit administrator URL for a dedicated PostgreSQL test instance. Optional controls:

| Option | Default | Meaning |
| --- | ---: | --- |
| `plan` | `[]` | Explicit actor choices (or `actor#n` lanes in the multi-producer profile), then fair rotation among available actors |
| `maxSteps` | 100 | Maximum released stages per run; whole cycles count once, staged metadata and continuation count separately |
| `timeoutMs` | 10,000 | Per-run execution deadline in milliseconds. File runs capture source identity before and after execution under a separate 60-second bound each |
| `maxEvidenceBytes` | 8 MiB | Recorded evidence budget per run |
| `maxConnectionsPerActor` | 1 (8 with `multi-producer-v1`) | Admitted PostgreSQL connection cap per actor; in the default profile additional live connections must remain queryless |
| `connectionProfile` | `single-producer-v1` | One live command connection per actor, or explicit `multi-producer-v1` connection lanes |
| `protocolProfile` | `sync-cycle-v1` | Whole cycles, or explicit `describe-flush-v1` metadata and continuation stages |
| `fixtureProfile` | `native` | Native PostgreSQL 16/17/18 capture, or explicit `postgresql17-pgvector0.8.6-v1` on its qualified server and extension |
| `source` | Automatic local module graph | File targets: `{ projectRoot?, include? }` selects the portable root and additional data paths |
| `signal` | — | Caller cancellation |

Exploration additionally supports `maxRuns` (100), `totalTimeoutMs` (60,000), `maxCandidates` (10,000), `maxSearchBytes` (64 MiB), and `stopOnFailure` (true). Retained bytes count encoded result data and candidate keys, not process heap usage. `omittedRuns`, `violationCount`, and `hardFailureCount` remain visible when a completed result cannot fit the retained-data budget. A resource stop never becomes an exhausted-frontier claim.

### Search selection and measurements

The default `strategy: 'fifo'` takes the oldest pending actor-choice prefix.
Candidate generation visits the most recent observed deviations first; this is
not breadth-first traversal by prefix length. The initial supplied plan, or the
empty plan with fair fallback, runs first under either strategy.

Set `seed` to an integer from 0 through 4,294,967,295 to select deterministic
seeded dequeue order, or specify both `strategy: 'seeded'` and `seed`. Explicit
`strategy: 'fifo'` with a seed, seeded strategy without a seed, negative zero,
fractions and values outside that range are errors. No seed is chosen implicitly.

```js
const search = await explore('./scenario.mjs', {
  databaseUrl: process.env.TEST_DATABASE_URL,
  maxRuns: 50,
  seed: 42,
});
console.log(search.search, search.metrics, search.pending, search.stopReason);
```

The summary records `search: { version: 1, strategy, seed? }`. Version 1 hashes
the ASCII string `interleave:seeded-frontier-v1`, a NUL, the unsigned decimal seed,
a NUL, and the zero-based attempt index with SHA-256. Its first four bytes,
read as an unsigned big-endian integer modulo pending frontier length, select
the next prefix. Remaining entries retain their order. This is deterministic
selection, not uniform random sampling. Identical seeds and identical returned
observations give identical prefix selection; changed observations or elapsed
time cutoffs can change the explored executions. Exact replay uses the retained
run's trace and captured inputs, independently of the search seed.

`metrics` summarizes every attempted run, including valid artifacts omitted from
`runs` because they exceed the search retention budget:

| Field | Meaning |
| --- | --- |
| `attemptedRuns` | Prefixes dispatched, including interrupted, incompatible and failed attempts |
| `completedRuns` | Validated passed, violation or actor-error artifacts with complete cleanup and completion evidence for every trace step |
| `maxAttemptedDepth` | Longest explicit prefix actually dispatched; the initial fair empty plan has depth zero |
| `recordedReleasedSteps` | Sum of recorded release units; a simple-query batch counts once, while staged metadata, execution and recovery count separately |
| `recordedActorSwitches` | Adjacent trace entries from different actors, counted within each run; reconnects of one actor do not count |
| `traceCountsComplete` | False if any attempt lacks valid completed evidence; release and switch counts must then be read as lower bounds |

Recorded release units do not count SQL statements, affected rows or confirmed
server executions. A partial trace can end before delivery or completion, and an
evidence fallback can omit trace entries. `explored` retains its existing meaning
and equals `attemptedRuns` in a returned search. Metrics describe observed
attempts; they do not establish coverage of untested schedules.

### Reduction and deadlines

Reduction supports `maxAttempts` (100) and `totalTimeoutMs` (60,000). Its initial exact verification counts as an attempt. It keeps the last verified matching failure; `locallyMinimal` applies to deleting explicit choices under the runner's fair fallback policy. It does not mean globally shortest execution or minimal application code.

Every reduction candidate must start with the verified PostgreSQL and Node.js versions, fixture identity, connection profile, and captured file identity when using a file target. Input drift stops reduction before candidate actors start and reports an inconclusive result with a reason; the retained run remains the last compatible failure. Candidate schedules may still change the queries that application code issues.

A hard failure during reduction stops work and adds `attemptFailure` with its
outcome, reason and cleanup details. This summary belongs to the failed trial;
the retained `run` remains the last verified invariant violation. Never infer
that every reduction attempt cleaned up solely from `run.cleanup`.

Deadlines interrupt execution. Owned database creation and cleanup have separate bounds and are awaited, so teardown can extend beyond an execution deadline.

`timeoutMs` also bounds waiting for an actor that has not issued its next command
or settled. There is no separate readiness timer. Waiting alone never counts as
a PostgreSQL lock observation. File supervision can interrupt a blocked worker;
an in-process scenario that synchronously blocks Node's event loop cannot be
preempted by its own timer.

Run outcomes are `passed`, `violation`, `actor-error`, `incompatible`, `inconclusive`, and `harness-error`. Only an invariant assertion produces `violation`. Inspect `reason`, `cleanup`, and the search stop reason; passing sampled schedules does not prove race freedom.

If an application operation rejects before an interruption, the interrupted run
reports `harness-error` and retains the failure reason. Its evidence is still
incomplete. Rejections caused by cancellation or cleanup alone do not turn an
otherwise inconclusive run into an application failure. A run that finishes all
operations with a rejection retains the ordinary `actor-error` outcome.

## Replay and artifacts

Exact replay requires completed evidence and cleanup. It checks the PostgreSQL and Node.js versions, starting fixture identity, actor connection startups (including connections that sent no SQL), command identity, connection generation, query fingerprints, observed lock waits and transaction state. Startup values contribute to hashes; their raw values are not copied into the connection record. File targets additionally check their selected source, actual installed dependencies and Interleave runtime. Exact replay and reduction inherit the recorded connection and protocol profiles and source selection unless explicitly overridden; changed exact inputs produce an incompatible result.

The same completed-evidence preflight applies to `replay`, `runOnce` and
`runScenarioFile` in exact mode, before database creation or file import. Partial
records remain readable for inspection and can supply guided actor hints.
Completed legacy records without fixture or connection identities return
`incompatible` before creating a database or importing a scenario. A guided run
can create new bound evidence from them.

New runs are schema version 3: `limits.protocolProfile` is always explicit and `environment.transport` is always present. Multi-producer runs are schema version 4, which adds a required `limits.connectionProfile: 'multi-producer-v1'` and `limits.maxConnectionsPerActor`, allows `actor#n` plan entries, and lists available lanes rather than actors in each step. The staged profile's steps carry explicit stage, cycle, and continuation links. Version 1 and 2 records remain readable and renderable with their original meanings (version 2 implies the staged profile). Because they predate transport identity, exact replay of a version 1 or 2 record on this runtime returns `incompatible` before database work; a guided run creates new version 3 evidence, and an exported bundle keeps its own original runtime for original replay. Exact staged replay checks SQL and Parse inputs before releasing metadata, then checks actual Bind inputs before releasing execution. Metadata records parameter and column counts or the real error; it does not claim row values, affected rows, transaction state, or equality of backend object identifiers. A completed run must close every staged cycle.

Replay returns the actual new command summaries, selected actor observations and
invariant outcome. It does not require row counts, SQLSTATEs, return values or
the final assertion result to equal the original record. Randomness, external
services and undeclared process state remain outside the scheduling guarantee.
Minimization separately requires the original invariant failure fingerprint.

Use `{ mode: 'guided' }` explicitly to try the old actor order against changed queries. A guided run is separately labeled and is new evidence.

`parseRunArtifact`, `readRunArtifact`, and `writeRunArtifact` validate the versioned format. Writes are atomic and private by default, and refuse replacement unless `{ overwrite: true }` is supplied. Artifacts preserve SQL, selected observations, and messages; those fields may contain sensitive application data. The proxy does not record authentication exchanges or cancellation keys. Review evidence before sharing it; automatic text replacement would change replay identity.

`renderReport` and `writeReport` produce a [standalone offline viewer](reports.md).
`exportRegression` and `verifyRegressionExport` produce and validate a
[portable regression bundle](regressions.md) with explicit source selection and
integrity hashes. Report and export operations do not execute a scenario.

Shared app/runtime exports preserve the original application lock and package
instance graph through one offline installation. `exportRegression` accepts
`runtimeArchive?: string` for the original lock-matching Interleave tarball and
`dependencyArchives?: string[]` for original local/private tarballs. Safe
contained files and locked official-registry HTTPS tarballs are discovered
automatically. All required archives must be available and verified; unsupported
topology or install hooks fail explicitly. The separate installation profile
remains available for recordings without shared instances.

`artifactFile?: string` preserves original JSON bytes after checking that the
parsed artifact equals the supplied run. The CLI supplies its selected artifact
file automatically; object-only API calls serialize the validated run. See the
regression guide for archive, installer and qualification limits.
