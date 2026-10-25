# Compatibility

Interleave's native PostgreSQL profile is qualified for PostgreSQL 16, 17, and 18. Each server major has a distinct fixture capture identity:

| PostgreSQL major | Fixture profile | Latest qualified server in this repository |
| --- | --- | --- |
| 16 | `postgresql16-native-v1` | PostgreSQL 16.15, official `postgres:16` image |
| 17 | `postgresql17-native-v1` | PostgreSQL 17.11, official `postgres:17` image |
| 18 | `postgresql18-native-v1` | PostgreSQL 18.6, official `postgres:18` image |

The server major is part of the fixture fingerprint. Strict replay therefore cannot treat fixtures captured on different PostgreSQL majors as equivalent. Artifact validation accepts all three profile names, while fixture capture rejects every other server major before reading application objects.

The qualification covers Interleave's native, extension-free fixture profile and its plaintext PostgreSQL protocol proxy using node-postgres 8.23.0. It exercises disposable database ownership and cleanup, schema/data/sequence/settings capture, queryless and reconnect startup binding, simple and ordinary extended query cycles, prepared statements, transaction errors, waits, replay, reduction, supervision, export, and the neveroversell example against each real server major.

The native fixture profile permits the built-in `plpgsql` extension. Other extensions, foreign relations, custom casts/operators, custom range/base types, temporary fixture state, logical replication configuration, and the other explicitly unsupported catalog features fail closed. Drivers other than node-postgres have separate qualification gates and are not covered by this matrix.

At commit `4b589dbac81eeef7bdabf461b105dc9bb29113b6`, all six PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0 jobs passed 758 tests each. Both PostgreSQL 17 / pgvector 0.8.6 jobs passed their ten checks, and the browser job passed 20 checks at each desktop/mobile size in Chromium, Firefox and WebKit. This includes seeded search, the Postgres.js protocol, installed pghybrid replay, and the [replay and release hardening](qualification/replay-release-hardening-2026-09-09.md). See the [completed nine-job CI run](https://github.com/pavangupta352/interleave/actions/runs/34322912399). The tag-only assets job was correctly skipped for this main-branch run.

PostgreSQL 17 renamed the catalog locale fields used by fixture capture from `daticulocale`/`colliculocale` to `datlocale`/`colllocale`. Interleave selects the fields by verified server major and retains a stable semantic `locale` field in its canonical input. It also includes ICU tailoring rules because they can change comparison behavior. See the official [PostgreSQL 17 release notes](https://www.postgresql.org/docs/17/release-17.html), [PostgreSQL 16 collation catalog](https://www.postgresql.org/docs/16/catalog-pg-collation.html), and [PostgreSQL 18 database catalog](https://www.postgresql.org/docs/18/catalog-pg-database.html).

PostgreSQL 18 virtual generated columns are covered by schema and logical row identity. The qualification verifies that otherwise equivalent stored and virtual generated columns have different schema identities while their application-visible values are captured. See the official [PostgreSQL 18 generated-column documentation](https://www.postgresql.org/docs/18/ddl-generated-columns.html).

## Operating systems

The qualification above and every CI job not named here run on Linux (Ubuntu
24.04). The `macos`
CI job runs the unit and integration suites with Node.js 22.18.0 and 24.7.0 on
GitHub's macOS 15 arm64 image against PostgreSQL 17 from Homebrew. The `windows`
job runs the same suites on GitHub's Windows Server 2025 image against the
image's PostgreSQL 17 service. Both servers were PostgreSQL 17.11 at the time of
writing. Version-tag release
preparation requires both jobs.

Recording, exact and guided replay, exploration, reduction and reports run on
Windows. `processActor` starts other programs there too; the suites check it with
Node.js programs, and the Python, Ruby, PHP, Go and Java examples have not been
run on Windows. What differs from Linux and macOS:

- Portable regression export (`interleave export`, `exportRegression`) and
  release preparation need a POSIX npm, Git and tar toolchain. Both refuse
  Windows with an explicit error, and their tests do not run there.
- Windows has no `O_NOFOLLOW`. Before reading a source file or artifact,
  Interleave checks with `lstat` that the path is not a symbolic link, then
  compares the opened file's device and inode with that check, so a link or a
  file swapped in between is refused as on other platforms.
- Supervision ends the worker process itself rather than a process group.
- Windows cannot send a signal to another process, so the test that interrupts
  a run and checks that its database is removed runs only on Linux and macOS.
  The CLI handles Ctrl+C, Ctrl+Break and the SIGHUP that Node.js raises when the
  console window closes; Windows ends the process about 10 seconds after the
  window closes, and these paths are not tested in CI. Ending the process
  without a signal, such as with `taskkill /F`, skips cleanup and leaves its
  `interleave_` database behind.
- Source identity hashes file bytes. A checkout with CRLF line endings has a
  different identity from an LF checkout of the same commit, so a recording made
  from one does not replay exactly from the other. Keep line endings consistent,
  for example with `* text=auto eol=lf` in `.gitattributes`.
- `--docker` has not been checked on Windows.

## Verified upstream TLS

Pass `upstreamTls: { mode: 'verify-full' }` in the API, `--upstream-tls` on the CLI, or `sslmode=verify-full` in the administrator URL. Every connection Interleave opens to PostgreSQL then verifies the server certificate chain and the URL hostname or IP address, using TLS 1.2 or 1.3 after PostgreSQL's SSLRequest negotiation. That covers database creation, setup and observer clients, fixture capture, the supervised worker's clients, each actor proxy's upstream session and cleanup. Trust is Node.js's bundled root set, or a PEM bundle you supply with `ca` / `--upstream-ca`, which replaces those roots rather than extending them (at most 1 MiB and 256 certificates). The policy and CA are resolved once per command or API call, so a CA file replaced mid-run cannot change cleanup trust.

Actors still connect to their own loopback endpoint in plaintext (`127.0.0.1`), and their driver's authentication bytes pass through unchanged. The first qualified authentication path is ordinary SCRAM-SHA-256 over the verified upstream connection. An actor that selects SCRAM-SHA-256-PLUS (channel binding) is refused with an explicit error, because the loopback leg has no upstream TLS channel to bind.

Not part of this profile: client certificates (mutual TLS), required channel binding, a verification name different from the URL host (tunnels), `sslmode` values other than `verify-full`/`disable`, direct TLS negotiation, and TLS on actor endpoints. `--docker` provisions a plaintext loopback server and cannot be combined with `--upstream-tls`.

The owned TLS qualification servers use official PostgreSQL images, `hostssl`-only authentication rules, SCRAM passwords and a generated private CA. They check both IP and DNS subject names, node-postgres ordinary cycles and the Postgres.js `describe-flush-v1` profile, and in-process and supervised file runs. They also cover exact replay, minimization, CLI `doctor` with `--upstream-ca`, and rejection of transport drift before any database work. The negative cases cover an unrelated CA, a certificate for another name, expired and not-yet-valid certificates, a wrong password and plaintext clients refused by the server. The [TLS qualification record](qualification/verified-upstream-tls-2026-09-27.md) lists versions, commands and unrun cases.

## Multi-connection actors

The explicit `multi-producer-v1` connection profile (`connectionProfile` in the
API, `--connection-profile` on the CLI) schedules each connection of an actor as
a lane; see [multi-connection actors](api.md#multi-connection-actors). It was
checked on 27 September 2026 against the official PostgreSQL 16.15, 17.11 and
18.6 images with Node.js 24.7.0, and against PostgreSQL 16.15 with Node.js
22.18.0. The checked applications are:

- node-postgres 8.23.0 `pg.Pool` (pg-pool 3.14.0) with `max: 2`: two concurrent
  read-modify-writes through `pool.query`, explicitly checked-out clients, and a
  side query through the pool while a checked-out client holds a transaction.
- Kysely 0.29.5 `PostgresDialect`: a transaction plus an availability check
  issued through the outer pool, which runs on a second connection.
- Postgres.js 3.4.9 with `max: 2` under `describe-flush-v1`, with metadata and
  execution stages open on both connections of one actor.

These runs recorded real lost updates and a double redemption, replayed them
exactly (including after the first pool socket was deliberately connected
second, which reverses accept order), reduced and explored lane-qualified
plans, and observed a real lock wait between two connections of one actor. A
connection blocked by an unscheduled session is `inconclusive`. The CLI path
covers supervised file runs, exact and guided replay, reduction, and an exported
bundle that installs offline and replays the recording exactly. The report shows
connection labels in Chromium, Firefox and WebKit at desktop and mobile sizes.

Keep each actor's pool within the per-actor cap (eight in this profile). Other
drivers, ORMs and pool implementations and larger pools have not been checked
with this profile. Its integration tests run in every PostgreSQL 16, 17 and 18
× Node.js 22.18.0 and 24.7.0 job of the CI matrix, and CI run 40150994903 passed
them all. One
[cancel request](#cancel-requests) case uses two connections of one actor in
this profile.

## Statement overlap

`overlap: 'pairs'` (`--overlap pairs`) releases the next commands of two actors or
lanes together; see [statement overlap](api.md#statement-overlap). It was checked
on 27 September 2026 against PostgreSQL 16.15 with Node.js 24.7.0, using a claim
that inserts a row only when none exists, in one statement that pauses after its
snapshot:

- Exploring without overlap tried every order and never failed; with overlap it
  found the duplicate claim on its third run, at the pair `alice+bob`.
- Exact replay of that pair repeated the failure, guided replay reran it, and
  reduction kept the pair as its one choice.
- An atomic `UPDATE ... SET value = value + 1` passed every sequential and
  paired choice.
- Postgres.js prepared statements under `describe-flush-v1` found the pair of
  execution stages, and replayed it exactly.
- A multi-producer pool paired two connections of one actor (`alice#0+alice#1`)
  and replayed through connection binding.
- The CLI recorded, replayed, reduced and reported the failure through supervised
  file runs, and the report marked the pair in Chromium, Firefox and WebKit.

The pause makes those checks deterministic. Real statements overlap for much less
time, so a real overlap failure can reproduce only some of the time. PostgreSQL
chooses how a pair interleaves; replay cannot force it. On the unchanged Knex
0.95.12 case study, overlap exploration found the duplicate lock row on its seventh
run and 30 of 30 exact replays repeated it, while 17 of the 46 explored runs that
paired the two inserts raced; see the
[case studies](case-studies.md#what-the-fix-left-open). The overlap integration
tests run in every PostgreSQL 16, 17 and 18 × Node.js 22.18.0 and 24.7.0 job of
the CI matrix, and CI run 40150994903 passed them all.

## Cancel requests

A driver cancels a running query by opening a new connection and sending a
CancelRequest: 16 bytes holding the backend process ID and the secret key that
PostgreSQL sent at startup. Interleave reads the request on the actor's
endpoint. When it names the backend of one of that actor's own live connections,
Interleave forwards the 16 bytes unchanged over a new upstream connection that
uses the run's transport policy, plaintext or verified TLS, and waits for
PostgreSQL to close it. A request naming any other backend is not forwarded.

The scheduler makes no decision while a forwarded request is outstanding, so a
request can only reach the command that was running when it arrived. If the
scheduler was still holding that actor's next command, the backend was idle:
PostgreSQL ignores the request, and the held command runs when it is released.
A slow network can produce the same ordering without Interleave.

Records with cancel requests use schema version 5. They list each request in
arrival order with its actor, arrival time, the backend it named, whether it was
forwarded, and the step it reached. The secret key is not recorded. A request
naming another actor's live connection stops the run as `inconclusive`; a
request naming an unknown backend is recorded and the run continues. Exact
replay requires every request to reach the same step, or find its backend idle,
as recorded. The application's own timers decide when a request arrives, so
that is timing dependent.

Checked on 25 October 2026 against PostgreSQL 16.15 with Node.js 24.7.0:

- Postgres.js 3.4.9 `query.cancel()` stopped `SELECT pg_sleep(30)` with SQLSTATE
  57014 in the `describe-flush-v1` profile, with a connection cap of one (the
  request arrives over the cap) and of two (it arrives as an admitted
  connection). Both replayed exactly.
- node-postgres 8.23.0 `Client#cancel` for a command the scheduler still held:
  PostgreSQL ignored the request, the command then completed, and the run
  replayed exactly.
- Two node-postgres connections of one actor in `multi-producer-v1`: the request
  named the sleeping connection, and replay bound it to the recorded one.
- psycopg 3.3.6 (binary, libpq 18.0) from a Python process actor: `cancel_safe()`,
  which uses libpq's `PQcancelCreate`, and `cancel()`, which uses the older
  `PQcancel`, each with exact replay.
- Forwarding over verified TLS to a TLS-only server, with exact replay.
- pgjdbc 42.7.13 on Java 21.0.11, from a Java process actor:
  `Statement.setQueryTimeout(1)` sent its cancel request from the driver's timer
  thread and stopped `SELECT pg_sleep(30)` with 57014, with exact replay.
- A libpq-style request for backend 1, with and without an SSLRequest first, was
  recorded and not forwarded. A request for another actor's backend was not
  forwarded and the run ended `inconclusive`.
- Replaying a record whose request had found its backend idle, while the new
  request reached the running command, was `incompatible`.
- The report tagged the command a request reached and listed every request in
  Chromium at desktop and mobile sizes.

CI run 40146537748 repeated these checks: the integration and verified-TLS
suites on PostgreSQL 16, 17 and 18 with Node.js 22.18.0 and 24.7.0, the psycopg
case on PostgreSQL 16 with Node.js 24.7.0, and the report in Chromium, Firefox
and WebKit. The CI `java` job repeats the pgjdbc case on PostgreSQL 16 with
Node.js 24.7.0.

## Streaming COPY

`COPY ... FROM STDIN` and `COPY ... TO STDOUT` run as one scheduled command.
Once Interleave releases it and PostgreSQL starts the copy, the client's
CopyData, CopyDone and CopyFail messages go upstream at once, and PostgreSQL's
copied rows go to the client, with backpressure in both directions. The command
completes at ReadyForQuery. For an extended-protocol COPY, which libpq's
`PQsendQueryParams` sends, the Sync that the client sends after CopyDone stays
part of the same command. Each CopyData message is limited to 16 MiB, the
proxy's message limit.

Records that contain COPY use schema version 5. Each COPY in a command's
completion lists its direction, byte count and the SHA-256 digest of the copied
data; the rows themselves are not recorded. Data sent with COPY FROM STDIN is
application input, so exact replay requires the same bytes and reports
`incompatible` when they change. When PostgreSQL rejects a copy partway, the
count is what the client had sent before Interleave saw the error, which depends
on timing, so replay does not compare it.

A COPY that PostgreSQL reports waiting on its own client, for data the
application has not produced yet or for a client that has stopped reading, lets
the scheduler release the actor's other connections. A pipeline from one
connection's COPY TO STDOUT into another's COPY FROM STDIN therefore runs in
either release order. Copied-out data is a result, like rows, and is
not compared. Replication's COPY BOTH is refused.

Checked on 25 October 2026 against PostgreSQL 16.15 with Node.js 24.7.0:

- pg-copy-streams 7.0.0 with node-postgres 8.23.0 copied in and out with exact
  replay, and replay with changed input rows was `incompatible`.
- Postgres.js 3.4.9 `writable()` and `readable()` streams, in the
  `describe-flush-v1` profile, with exact replay.
- A destroyed pg-copy-streams stream sent CopyFail after one row: PostgreSQL
  answered SQLSTATE 57014, the record kept the 8 bytes sent, and the next query
  on that connection ran.
- 200,000 rows (19,488,890 bytes) copied in, then read back slowly through COPY
  TO STDOUT, kept their exact byte counts and digests.
- Two actors copying the same key in open transactions: the second copy waited
  for the first actor's transaction, the scheduler observed that lock wait and
  released the first actor's COMMIT, the second copy failed with 23505, and the
  run replayed exactly.
- psycopg 3.3.6 `copy()` in both directions, and an extended-protocol COPY
  through libpq 18.0's `PQsendQueryParams`, from a Python process actor, with
  exact replay.
- A pg-copy-streams pipeline from one pool connection's COPY TO STDOUT into
  another's COPY FROM STDIN moved 50,000 rows in both release orders, in
  `multi-producer-v1`, with exact replay.
- pgjdbc 42.7.13 `CopyManager` `copyIn` and `copyOut` from a Java process actor,
  with exact replay.
- psycopg's binary COPY (`FORMAT BINARY`, `write_row`): the recorded bytes were
  exactly PostgreSQL's binary copy format for the row, signature to trailer.
- node-postgres without a copy stream: copied-out data was measured and
  discarded by the driver, and a copy in failed with the driver's own CopyFail.
- The report listed each transfer's direction, byte count and digest in
  Chromium at desktop and mobile sizes.

CI run 40146537748 repeated these checks on PostgreSQL 16, 17 and 18 with
Node.js 22.18.0 and 24.7.0, the psycopg and libpq case on PostgreSQL 16 with
Node.js 24.7.0, and the report in Chromium, Firefox and WebKit. The CI `java` job
repeats the pgjdbc case.

## PostgreSQL 17 with pgvector 0.8.6

The separate `postgresql17-pgvector0.8.6-v1` fixture profile is qualified on
PostgreSQL 17.11 using the exact
`pgvector/pgvector:0.8.6-pg17-bookworm` image. It is selected explicitly with
`fixtureProfile: 'postgresql17-pgvector0.8.6-v1'` in the API or
`--fixture-profile postgresql17-pgvector0.8.6-v1` in the CLI. It never replaces
the extension-free native default.

This profile validates the exact vector extension membership and catalog
contract, effective pgvector settings, supported vector values, and the existing
native fixture surface. Qualification includes actual pghybrid 0.1.4 searches
recorded and exactly replayed through `forPg`, `forPostgresJs`, `forDrizzle` and
`forKysely`, using real callers. The [adapter qualification](qualification/pghybrid-adapters-2026-09-09.md)
records the exact versions, installed replay and interruption limits. See the
[pgvector and pghybrid qualification record](qualification/postgresql17-pgvector-pghybrid-2026-09-09.md)
and the [self-contained pghybrid example](../examples/pghybrid/README.md).

Vector must be installed in `public` and owned by the capture role. Catalog
identity does not attest the installed server binary.

## Running the database matrix

`npm run test:integration` provisions an owned `postgres:16` container when `TEST_DATABASE_URL` is absent. Select another qualified major with the exact official tag:

```sh
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:17 npm run test:integration
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:18 npm run test:integration
INTERLEAVE_TEST_POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg17-bookworm npm run test:integration -- pgvector
```

`INTERLEAVE_TEST_POSTGRES_IMAGE` accepts exactly `postgres:16`, `postgres:17`, `postgres:18`, or `pgvector/pgvector:0.8.6-pg17-bookworm`. The pgvector image enables the vector qualification files; the `pgvector` argument restricts the run to them. Without that argument, integration tests also run the native fixtures on the selected server. Native-image runs exclude vector files explicitly. The harness binds a random loopback port, generates a random password, labels the container with an unguessable run identity, verifies that identity before cleanup, and removes the container and its anonymous volumes after the run. If `TEST_DATABASE_URL` is explicitly set, tests use that dedicated administrator endpoint instead of starting a container; retain the image selector to choose the intended test profile.

The dated, immutable image identities and measured test results are in the [native PostgreSQL qualification record](qualification/postgresql-native-matrix-2026-09-09.md).

Run the explicit vector tests with:

```sh
INTERLEAVE_TEST_POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg17-bookworm npm run test:integration -- pgvector
```

Native jobs exclude files ending in `.pgvector.integration.test.ts`; the selected
vector profile runs them against an extension-capable server. Setting an image
while supplying `TEST_DATABASE_URL` selects the tests but does not change that
server: it must already provide the stated PostgreSQL and extension versions.

## Postgres.js protocol profile

Postgres.js 3.4.9 parameterized queries use the opt-in `describe-flush-v1`
protocol. Real Parse/Describe/Flush metadata and later Bind/Execute/Sync work
have separate release gates and schema-version-2 evidence. Cached prepared
queries can still use a complete-cycle release. See the [driver qualification
record](qualification/postgresjs-describe-flush-2026-09-09.md) and
[runnable example](../examples/postgresjs/README.md), including the required
driver shutdown listener for interrupted transactions.

The separate [transaction-conflict qualification](qualification/postgresjs-transaction-conflicts-2026-09-09.md)
records real `40P01` rollback and `40001` whole-transaction retries on PostgreSQL
16.13, with both preparation settings and explicit `fetch_types: false`.
PostgreSQL can choose another deadlock victim on replay; a resulting change in
the application's COMMIT/ROLLBACK order is correctly reported as incompatible.

## Cursors and Flush stages

The opt-in `flush-stages-v1` profile releases each group of extended-protocol
messages that ends in Flush, and keeps the cycle open until its Sync. That is how
cursor clients read a large result in batches: Execute with a row limit, Flush,
and PortalSuspended until the last batch. An application may also abandon a
cursor: its cycle stays open, every stage it released is recorded as completed,
and PostgreSQL rolls the cycle back when the session ends. Another actor's commands can run
between two batches, which is where a cursor's snapshot and locks meet other
writers. Each Flush release completes once PostgreSQL has answered every message
in it.

Checked on 25 October 2026 against PostgreSQL 16.15 with Node.js 24.7.0:

- pg-cursor 2.22.1 with node-postgres 8.23.0 read five rows two at a time while
  another actor committed an update between two batches. The cursor kept the
  portal's snapshot and returned the old value; a schedule that ran the update
  first returned the new one. Exact replay repeated the stage sequence.
- A cursor closed after its first batch ended its cycle with Close and Sync. An
  error in a later batch (SQLSTATE 22012) was followed by a Sync-only recovery,
  and the connection's next query ran. Exact replay.
- A `SELECT ... FOR UPDATE` cursor's batch waited for a row that another actor
  had updated in an open transaction. The scheduler observed the lock wait inside
  the open cycle and released the other actor's COMMIT. Exact replay.
- pg-query-stream 4.17.1 with a batch size of two, and Postgres.js 3.4.9
  `cursor()` with a parameterized statement (described first) and with an early
  `break`, with exact replay.
- The report labeled Flush stages and the closing Sync, with rows returned and
  the suspended portal, in Chromium at desktop and mobile sizes.

- libpq 18.0 pipeline mode through psycopg 3.3.6's `pq` module: two queued
  statements and a flush request became one Flush stage, and `PQpipelineSync`
  closed the cycle. Another actor's update of the same row waited on the
  pipeline's uncommitted UPDATE until that Sync committed it. The default
  profile refused the pipeline with a reason naming `flush-stages-v1`. Exact
  replay.
- The [cursor example](../examples/cursor/README.md), installed from the package:
  an interest job that reads accounts through pg-cursor and writes through a
  second pool connection lost a concurrent deposit on its second explored order,
  with both `flush-stages-v1` and `multi-producer-v1`; the atomic version passed
  all 19 orders.

CI run 40146537748 repeated these checks, including the installed cursor
example, on PostgreSQL 16, 17 and 18 with Node.js 22.18.0 and 24.7.0, the libpq
pipeline case on PostgreSQL 16 with Node.js 24.7.0, and the report in Chromium,
Firefox and WebKit.

pgjdbc 42.7.13 reads with a fetch size only inside a transaction, and fetches
each batch with its own Execute and Sync, so it runs under the default profile
without Flush stages. A `setFetchSize(2)` query over five rows became three
cycles on the same portal, checked from a Java process actor with exact replay.

## External programs as actors

`processActor` runs a separate program per actor and gives it only that actor's
loopback endpoint. Ten examples in five languages are qualified against
PostgreSQL 16 through the same installed-package workflow: the packed Interleave
is installed in a new application, the example folder is copied in, and its
README commands run from the application root. In each, the unsafe program
oversold (two orders for one unit), exact replay reproduced the same invariant
failure, editing the included program made exact replay incompatible, and the
repaired program's search found no violation: a fully explored frontier, except
for the bounded searches of the ORMs whose setup commands make the frontier too
large. Every driver ran with its default statement handling.

| Example | Driver and runtime | Repaired frontier |
| --- | --- | ---: |
| [Python](../examples/python/README.md) | psycopg 3.3.6 (binary wheel, libpq 18) on Python 3.14 | 47 schedules |
| [Ruby](../examples/ruby/README.md) | pg gem 1.6.3 (arm64-darwin native gem, libpq 18.1) on Ruby 4.0.5 with Bundler 4.0.11 | 47 schedules |
| [PHP](../examples/php/README.md) | PDO `pdo_pgsql` on PHP 8.5.0 (libpq 18.1) | 619 schedules |
| [Go](../examples/go/README.md) | pgx 5.11.0 on Go 1.27.1 | 295 schedules |
| [Java](../examples/java/README.md) | pgjdbc 42.7.13 on OpenJDK 21.0.11, single-file source launcher | 183 schedules |
| [asyncpg](../examples/asyncpg/README.md) | asyncpg 0.32.0 on Python 3.14, with `--protocol-profile flush-stages-v1` | 295 schedules |
| [SQLAlchemy](../examples/sqlalchemy/README.md) | SQLAlchemy 2.1.4 ORM over psycopg 3.3.6 on Python 3.14 | 200 seeded orders, run budget (exit 4) |
| [Django](../examples/django/README.md) | Django 6.1.2 ORM over psycopg 3.3.6 on Python 3.14 | 295 schedules |
| [Active Record](../examples/activerecord/README.md) | Active Record 8.1.4 over the pg gem 1.6.3 on Ruby 4.0.5 | 200 seeded orders, run budget (exit 4) |
| [GORM](../examples/gorm/README.md) | GORM 1.31.2 with its PostgreSQL driver 1.6.3 (pgx 5.10.0) on Go 1.27.1 | 200 seeded orders, run budget (exit 4) |

The Ruby, PHP, Go and Java rows ran on macOS (arm64) with Node.js 24.7.0 and
22.18.0, and the asyncpg, SQLAlchemy, Django, Active Record and GORM rows with
Node.js 24.7.0. The
`python`, `ruby`, `php`, `go` and `java` CI jobs repeat the workflow on Ubuntu
24.04 with Node.js 24.7.0 and PostgreSQL 16, using the runtimes their setup
actions install (Python 3.13, Ruby 4.0.5, PHP 8.5, Go 1.27.1 and Temurin Java
21). Separate Node.js programs using node-postgres are covered by the
integration suite in-process, including exact replay.

Interleave schedules every protocol cycle a driver sends, so a driver's default
statement handling decides how many steps an actor takes:

- psycopg and the pg gem's `exec_params` send one extended cycle per statement.
- pgx prepares each new statement as a named prepared statement in its own
  Parse/Describe/Sync cycle, then executes it in another cycle.
- PDO prepares each statement in its own cycle, executes it in another, and
  closes it in a third when the PHP statement object is released.
- pgjdbc sets `application_name` with a simple query after connecting and, with
  autocommit off, sends `BEGIN` as its own simple query.
- asyncpg prepares each statement with Parse, Describe and Flush, waits for the
  answer, and then executes it with Bind, Execute and Sync, with a row limit for
  `fetchval`. The default profile refuses the Flush and `describe-flush-v1`
  refuses the row limit, so it needs `flush-stages-v1`, which records the
  prepare and the execution as two steps.
- SQLAlchemy sends nine setup commands on each new connection (server version,
  schema, isolation level, `standard_conforming_strings`, a type lookup inside a
  savepoint, and the surrounding `BEGIN` and `ROLLBACK`), so two actors have far
  more orders than a search can finish; its repair is checked with a seeded
  search of 200 orders.
- Django sets the connection's time zone with `set_config` before the first
  query and, in autocommit mode, sends each ORM call as one statement.
- Active Record sends twelve setup commands on each new connection (session
  settings, type lookups, `SHOW search_path` and the table's schema), three more
  the first time it touches another table, and prepares each model query before
  executing it; its repair is checked with a seeded search of 200 orders.
- GORM's PostgreSQL driver sends `-- ping` twice when it opens, prepares each
  statement in its own cycle as pgx does, and wraps each write in `begin` and
  `commit`; its repair is checked with a seeded search of 200 orders.

A cycle that only prepares or closes a statement executes nothing: it completes
without a command tag and is recorded with that statement's text. Each extra
step can interleave with the other actor, so the same repaired checkout has 47
schedules with the pg gem and 619 with PDO. Searches that large need budgets
beyond the defaults (`--max-runs`, and for PDO also `--max-search-bytes`); each
example's README gives the budget it was verified with. A single search's
`totalTimeoutMs` is at most one hour.

Startup parameters are part of exact replay identity. The pg gem sends the
program's path, shortened to its first and last 30 characters, as
`application_name` unless the connection sets one, so the Ruby recording
reported `incompatible` when replayed from a copy of the application in another
directory. The PHP, Go and Java recordings replayed the same failure from such a
copy. pgjdbc sends the JVM's time zone, and replaying the Java recording with a
different `TZ` reported `incompatible`. pgjdbc's default `sslmode=prefer` first
requests TLS; the actor endpoint declines, and the driver continues in
plaintext.

Not qualified: these examples on PostgreSQL 17 and 18,
Windows, other driver modes (pgx's other query execution modes and pools,
pgjdbc after `prepareThreshold` switches to server-prepared statements, PDO
emulated prepares, `pdo_pgsql` built against libpq older than 17), ORMs on these
drivers other than SQLAlchemy, Django, Active Record and GORM, programs that open more than one command-producing connection per
actor, and regression exports of language actors. Other clients, such as Npgsql,
are expected to work when they read `DATABASE_URL` or the libpq `PG*` variables
and stay within the qualified protocol subset, which includes pipelined cycles
that each end with Sync, [cancel requests](#cancel-requests) and
[streaming COPY](#streaming-copy). Cursors and pipelines that wait on Flush need
`flush-stages-v1` (see [cursors and Flush stages](#cursors-and-flush-stages)).
Treat them as unverified until their own workflow runs.

## TypeORM

The [TypeORM example](../examples/typeorm/README.md) gives each actor its own DataSource and a node-postgres pool of size one through TypeORM's public driver option. The helper and scenario are qualified unchanged with TypeORM 1.1.1 and 0.3.31 (each with its own lockfile), node-postgres 8.23.0, Node.js 22.18.0 and PostgreSQL 16, 17 and 18. Eleven functional cases per row cover entity CRUD, committed and rolled-back transactions with a real 23505, a real 40001 serialization failure handled by whole-transaction retry (and reported as an actor error without retry), the unsafe lost update with exact replay and minimization, source drift rejection, and original-archive export with offline installation and exported exact replay. Fourteen lifecycle checks cover acquisition, errors, backend termination and cancellation.

TypeORM 1.1.1 requires Node.js 20.19+, 22.13+ or 24.11+, so Node.js 24.7 is not a supported row. Closing a TypeORM client is not a PostgreSQL CancelRequest: a blocked backend can keep waiting until its blocker finishes or the generated database is cleaned up. Relations, `manager.transaction()`, pessimistic locks and deadlock retry have not been qualified.

## Sequelize, Knex and MikroORM

The [Sequelize](../examples/sequelize/README.md), [Knex](../examples/knex/README.md)
and [MikroORM](../examples/mikro-orm/README.md) examples give each actor its own
ORM instance with a pool of one connection over node-postgres 8.23.0. The helpers
keep each ORM's own transaction API and startup commands. The MikroORM helper
turns off `ensureDatabase`, whose SQL contains the generated database name, so
exact replay could never match it.

| ORM | Installed packages | Commands per actor before the first application query |
| --- | --- | --- |
| Sequelize 6.37.8 | `sequelize` 6.37.8, `pg` 8.23.0 | Three. Session settings and a type query on a version connection that Sequelize closes, then the session settings again on the pool connection |
| Knex 3.3.0 | `knex` 3.3.0, `pg` 8.23.0 | One: `select version();` |
| MikroORM 6.6.17 | `@mikro-orm/core`, `@mikro-orm/knex` and `@mikro-orm/postgresql` 6.6.17, `knex` 3.2.10, `pg` 8.23.0, and `pg` 8.20.0 nested under `@mikro-orm/postgresql` for type parsers only | Two: `select version();` and `select 1` |

`npm run test:orms`, with `INTERLEAVE_ORM` set to `sequelize`, `knex` or
`mikro-orm`, installs the example's lock and the Interleave archive under test
into a new application and runs 14 checks there against real PostgreSQL:

1. The CLI records the unsafe read-then-write as a violation, with both actors
   reading 0 and writing 1. The startup commands are scheduled steps with the
   exact SQL listed in each example's README, and every connection presents the
   same startup parameters.
   Exact replay repeats the failure, the actor values, the source and fixture
   identity and every step fingerprint.
2. Library `explore` finds the same failure, and library `replay` repeats it.
3. CLI minimization keeps the failure fingerprint and reports `locally-minimal`.
4. The atomic write, which keeps the read, passes under the same alternation
   with written values 1 and 2.
5. After the entry switches to the atomic write, exact replay is `incompatible`
   before any import or setup, and guided replay of the recorded order passes.
6. CRUD commits. A duplicate primary key fails with 23505 in transaction state
   E, ROLLBACK returns to state I, the marker row is absent and the same
   connection keeps working.
7. With both snapshots taken first, bob's UPDATE waits on alice's row lock and
   fails with 40001 after her COMMIT. Without retry the outcome is `actor-error`
   and the invariant is not called.
8. With whole-transaction retry, bob checks that his failed attempt's marker is
   gone and commits on his second attempt after reading 1.
9. Both serializable behaviors pass under a serial schedule (two checks).
10. After a comment is appended to the copied helper, exact replay is
    `incompatible` before any import or setup.
11. A 5-second deadline while bob never issues a command leaves alice's first
    ORM command unreleased. The run is `inconclusive`, alice's operation
    rejected, bob's fulfilled, and cleanup is complete.
12. `export --runtime-archive` with the original archive, `install.mjs
    --offline` and the exported exact replay repeat the failure with the same
    identities and fingerprints.
13. No generated database, backend or command process remains, and the
    application lock is unchanged.

The evidence directory keeps `install.json`, numbered command records (`NN.json`,
`NN.stdout`, `NN.stderr`), every run artifact, the journals (`imports.txt`,
`owned.txt`, `invariants.jsonl`), `identity.json` with the recorded packages,
`api-summary.json`, `minimize-summary.json`, `export-manifest.json`,
`cleanup.json`, `results.json` with each check's duration, and the exported
bundle.

All 18 rows passed on 25 October 2026 on macOS arm64, against the official
`postgres:16`, `postgres:17` and `postgres:18` images (PostgreSQL 16.15, 17.11
and 18.6), with the Interleave 0.2.0 archive built from commit `d572265`. Each
cell gives the passing checks and the gate's duration. The rows ran one at a
time, and other work on the machine slowed some of them. The `orms` CI job runs
the same gate for each row on Ubuntu 24.04.

| ORM | Node.js / npm | PostgreSQL 16.15 | PostgreSQL 17.11 | PostgreSQL 18.6 |
| --- | --- | --- | --- | --- |
| Sequelize 6.37.8 | 22.18.0 / 10.9.3 | 14/14, 108 s | 14/14, 119 s | 14/14, 65 s |
| Sequelize 6.37.8 | 24.7.0 / 11.5.1 | 14/14, 64 s | 14/14, 59 s | 14/14, 58 s |
| Knex 3.3.0 | 22.18.0 / 10.9.3 | 14/14, 44 s | 14/14, 39 s | 14/14, 40 s |
| Knex 3.3.0 | 24.7.0 / 11.5.1 | 14/14, 55 s | 14/14, 60 s | 14/14, 39 s |
| MikroORM 6.6.17 | 22.18.0 / 10.9.3 | 14/14, 62 s | 14/14, 63 s | 14/14, 66 s |
| MikroORM 6.6.17 | 24.7.0 / 11.5.1 | 14/14, 60 s | 14/14, 72 s | 14/14, 94 s |

The recorded source identity was 20,541,744 bytes in 2,906 files for Sequelize,
7,856,485 bytes in 1,704 files for Knex and 11,820,145 bytes in 2,619 files for
MikroORM, within the default bounds. Minimization reduced the 10, 6 and 12
recorded choices to none in 5, 4 and 5 attempts, because the fair fallback alone
reproduces each lost update. The library search found it on its first run.

None of the three ORMs declares a dependency on the pg that opens its
connections. Sequelize and Knex list `pg` only in `peerDependenciesMeta` and load
it with a computed `require`, which the recorded dependency graph does not
follow. MikroORM depends on its own pg 8.20.0 for type parsers and connects
through Knex 3.2.10, which loads pg the same way. In these examples npm installs
one copy of pg 8.23.0 that Interleave's own runtime also depends on, so every
recording hashes its files as part of the runtime component, and for MikroORM
also through pg-pool's peer dependency. An application whose pg version differs
from Interleave's gets two installations. Unless a declared relationship reaches
the copy its ORM loads, only the recorded `package-lock.json` covers that copy,
not its installed files.

The Knex application shares no installed package with Interleave's runtime,
because Knex pins pg-connection-string 2.6.2 while pg 8.23.0 uses its own 2.14.0.
Interleave 0.2.0 could not export such a recording when the application had
installed Interleave from a local archive. Supplying `--runtime-archive` now
exports it as an offline installation of the original application lock.

Not checked: other APIs of these ORMs (Sequelize associations, hooks and CLS
transactions; Knex migrations, streams and its `connectionPool` option;
MikroORM relations, decorators, `em.lock()` and migrations), deadlock (`40P01`)
handling, serialization failures at COMMIT, pools larger than one connection or
the multi-connection profile, the `pg-native` bindings, Sequelize 7, MikroORM 7,
Windows, and exact replay across Node.js or PostgreSQL versions.

## Prisma ORM 7.10.0

Prisma ORM 7.10.0 is qualified through its node-postgres driver adapter:
`@prisma/client` 7.10.0 and `@prisma/adapter-pg` 7.10.0 over `pg` 8.23.0, using
the default `sync-cycle-v1` profile. The `prisma-client` generator writes the
client into the application as TypeScript that Node.js 22.18.0 and 24.7.0 load
directly, so the generated files are recorded as scenario source. Each actor owns
one `PrismaClient` whose adapter pool has `max: 1`. Prisma sends BEGIN, COMMIT
and ROLLBACK as simple queries and model operations as parameterized extended
cycles; with the adapter's `statementNameGenerator`, every command is a named
prepared statement that node-postgres reuses on the same connection.

The [installed-consumer gate](../examples/prisma/README.md#qualification-gate)
passed all 13 checks with Node.js 22.18.0 and 24.7.0 against PostgreSQL 16.15,
17.11 and 18.6: CLI and library recording, exact replay and minimization,
rejection of an edited generated client and of a regenerated schema before any
import, byte-identical regeneration, serializable `40001`/`P2034` retry and the
unhandled actor error, `23505` rollback with CRUD on the same connection, named
statement reuse, and a guided rerun plus exhaustive fresh exploration after a
repair. See the [qualification record](qualification/prisma-orm-7.10.0-2026-09-27.md).

Boundaries of this profile:

- `@prisma/client` 7.10.0 alone installs 74,458,946 bytes; the example's recorded
  source identity was 82,478,406 bytes in 602 files with a 0.1.0 development
  build and 82,568,411 bytes in 605 files with 0.2.1, within the 128 MiB default
  budget. Builds with the earlier 64 MiB default, including the `3785d49`
  candidate and the 0.1.0 package prepared at `ebbadbc`, stop every Prisma
  7.10.0 recording as `inconclusive` with `Source identity byte limit exceeded`
  before any SQL runs.
- The recorded application must not install the Prisma CLI where its modules
  resolve packages. `@prisma/client` declares the CLI as an optional peer, and
  installed peers are recorded; with the CLI beside the client the closure is
  310,499,758 bytes in 10,437 files and exceeds every capture bound. Generate the
  client with a separately installed CLI, as the example does.
- Portable shared export is unsupported: the original
  `@prisma/client-7.10.0.tgz` is 26,828,688 bytes, above the 16 MiB per-archive
  bound. Export exits 2 without creating a bundle.
- Not qualified: Prisma 8, other driver adapters, Accelerate and Prisma Postgres,
  relation queries and nested writes, deadlock (`40P01`) handling, `prisma
  migrate` against the test server, and replay across Node.js or PostgreSQL
  versions.
