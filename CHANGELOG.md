# Changelog

## Unreleased

### Changes

- `interleave init` gives the scaffold's client an `'error'` listener, so a
  dropped connection no longer ends the worker with an uncaught error.
- The refusals to replace an existing artifact or report name `--force` as well
  as `{ overwrite: true }`.

## 0.3.0 — 25 October 2026

Interleave now forwards cancel requests, streams COPY, schedules cursors one batch
at a time, and runs on Windows. Ruby, PHP, Go and Java programs, the Sequelize,
Knex and MikroORM ORMs, and Python, Ruby and Go ORMs are qualified as actors.

### Features

- Ruby, PHP, Go and Java examples for `processActor`, each using its driver's
  default statement handling: the pg gem 1.6.3, PDO `pdo_pgsql`, pgx 5.11.0 and
  pgjdbc 42.7.13. Gated `ruby`, `php`, `go` and `java` CI jobs run their
  installed-package workflow, and version-tag release preparation requires them.
- Route PostgreSQL cancel requests. A driver's CancelRequest for one of the
  actor's own connections is forwarded to PostgreSQL unchanged, over the run's
  plaintext or verified TLS transport, so `query.cancel()` in Postgres.js,
  `Client#cancel` in node-postgres and `cancel_safe()` in psycopg stop a running
  statement with SQLSTATE 57014. No scheduling decision is made while a request
  is outstanding, so a request reaches only the command that was running when it
  arrived. Requests that name any other backend are not forwarded; one that names
  another actor's live connection makes the run `inconclusive`.
- Runs that receive cancel requests record them in schema version 5: each request
  in arrival order with its actor, arrival time, backend, whether it was
  forwarded and the step it reached. Secret keys are never recorded. Exact replay
  requires each request to reach the same step, or find its backend idle. The
  report tags the command a request reached and lists every request.
- Stream `COPY ... FROM STDIN` and `COPY ... TO STDOUT` through the proxy, from
  pg-copy-streams, Postgres.js `writable()` and `readable()`, psycopg `copy()`
  and libpq, including extended-protocol COPY. The copy is part of one scheduled
  command, with backpressure in both directions, and a copy that waits on
  another actor's lock is observed like any other wait. Version 5 completions
  record each COPY's direction, byte count and SHA-256 digest, never the rows;
  exact replay requires the same COPY FROM STDIN data. In the multi-producer
  profile, a COPY that waits on its own client lets only the same actor's other
  connections run, so a pipeline between two connections' COPY commands works in
  either order. COPY BOTH, used only by replication, is still refused.
- Schedule cursors and other clients that wait on Flush with the opt-in
  `flush-stages-v1` profile (`--protocol-profile flush-stages-v1`). Every group
  of extended-protocol messages that ends in Flush is its own release, so another
  actor can run between two batches of pg-cursor, pg-query-stream or Postgres.js
  `cursor()`. A Flush release completes once PostgreSQL has answered all of it;
  the cycle stays open until its Sync, and only a lone Sync may follow an error.
  A cursor the application abandons leaves its cycle open without failing the run.
  Records are schema version 5 and show each stage's rows and whether the portal
  was suspended. The [cursor example](examples/cursor/README.md) is an interest job
  that loses a concurrent deposit between two batches.

- Run on Windows: recording, exact and guided replay, exploration, reduction
  and reports. New `windows` and `macos` CI jobs run the unit and integration
  suites with Node.js 22.18.0 and 24.7.0 on Windows Server 2025 and macOS 15
  against PostgreSQL 17, and version-tag release preparation requires them.
  Portable export still needs Linux or macOS and refuses Windows with an
  explicit error. Without `O_NOFOLLOW` on Windows, Interleave refuses a symbolic
  link by checking the opened file against an `lstat` of its path. See
  [operating systems](docs/compatibility.md#operating-systems).

### Qualified profiles

- Ruby 4.0.5, PHP 8.5.0, Go 1.27.1 and Java 21 programs through `processActor`
  on PostgreSQL 16 with Node.js 22.18.0 and 24.7.0. In each, the unsafe checkout oversells,
  exact replay repeats the failure, an edited program makes exact replay
  incompatible, and the repaired checkout passes a fully explored frontier (47,
  619, 295 and 183 schedules). See
  [compatibility](docs/compatibility.md#external-programs-as-actors) for how each
  driver's protocol cycles become scheduling steps and which startup parameters
  tie exact replay to a directory or time zone.
- Sequelize 6.37.8, Knex 3.3.0 and MikroORM 6.6.17 over node-postgres 8.23.0 on
  PostgreSQL 16, 17 and 18 with Node.js 22.18.0 and 24.7.0, through isolated
  [Sequelize](examples/sequelize/README.md), [Knex](examples/knex/README.md) and
  [MikroORM](examples/mikro-orm/README.md) examples with per-actor helpers. The
  installed-package gate `npm run test:orms` runs 14 checks per row, including
  exact replay, minimization, guided replay of a repair, retry, interruption at a deadline and
  portable export. The MikroORM helper turns off `ensureDatabase`, whose SQL
  contains the generated database name. See
  [compatibility](docs/compatibility.md#sequelize-knex-and-mikroorm).
- The new `orms` CI job family runs that gate for every row, and release
  candidates require it.
- pgjdbc 42.7.13 fetch-size cursors, `Statement.setQueryTimeout` and
  `CopyManager` through a Java process actor, with exact replay. The fetch-size
  cursor runs under the default profile because pgjdbc ends each batch with Sync.

- asyncpg 0.32.0 and the SQLAlchemy 2.1.4 and Django 6.1.2 ORMs (over psycopg
  3.3.6) as Python process actors on PostgreSQL 16, in
  [asyncpg](examples/asyncpg/README.md), [SQLAlchemy](examples/sqlalchemy/README.md)
  and [Django](examples/django/README.md) examples that the `python` CI job runs.
  asyncpg needs `--protocol-profile flush-stages-v1`, because it prepares each
  statement with a Flush. SQLAlchemy sends nine setup commands per connection, so
  its repair is checked by a seeded search of 200 orders rather than a complete
  frontier.
- Active Record 8.1.4 (Ruby, over the pg gem 1.6.3) and GORM 1.31.2 (Go, with its
  PostgreSQL driver 1.6.3) as process actors on PostgreSQL 16, in
  [Active Record](examples/activerecord/README.md) and [GORM](examples/gorm/README.md)
  examples that the `ruby` and `go` CI jobs run. Both send many setup and
  transaction commands per connection, so their repairs are also checked by
  seeded searches of 200 orders.

### Fixes

- The refusals for a second simultaneous connection and for a Flush-dependent
  query name the CLI flag (`--connection-profile`, `--protocol-profile`) as well
  as the API option, so a CLI user sees which flag selects the profile.
- The CLI stops and cleans up on SIGHUP (exit 129) as it does on SIGINT and
  SIGTERM. A terminal that closed during a run used to end it without removing
  its database. On Windows, Node.js raises SIGHUP when the console window closes,
  and Ctrl+Break's SIGBREAK now stops a run too (exit 149).
- When an uncaught exception or unhandled promise rejection ends the scenario
  worker, the run's reason says which. For an uncaught exception it names a
  client or pool without an `'error'` listener as the usual cause. It used to say only that the worker
  exited before completing. The error's own text is still never recorded.
- A protocol cycle that prepares, describes or closes a statement without
  executing it records that statement's SQL once. pgx's Parse/Describe/Sync
  prepare cycle previously showed the statement twice, as if it had run two
  commands. Replay now compares commands by fingerprint rather than by this
  text, so records made before the change still replay.
- Export accepts `--runtime-archive` and `--dependency-archive` (`runtimeArchive`
  and `dependencyArchives`) for a recording whose application shares no installed
  package with Interleave's runtime, and exports it as an offline installation of
  the original application lock. Before, such a recording could not be exported
  when the application had installed Interleave from a local archive: export
  rejected the archive options, and the separate installation rejected the local
  runtime entry in the application lock. A Knex 3.3.0 application is one such
  case. Export also selects that installation by itself when the app's lock
  installs Interleave from a local archive and export runs from that installed
  copy, and asks for `--runtime-archive` when that archive is outside the project. An
  empty `dependencyArchives` list selects nothing, and the error for another
  local archive dependency names `dependencyArchives` (`--dependency-archive`)
  only when supplying it can work.

## 0.2.1 — 25 October 2026

0.2.1 is the first release of the 0.2 line. The `v0.2.0` tag was never released:
its release-asset check found that npm leaves the Prisma example's nested
`.gitignore` out of the package. 0.2.1 keeps that ignore rule at the repository
root; the library and CLI are the same as at the `v0.2.0` tag.

Interleave can now schedule actors that use several connections at once,
explore races inside a single statement, and record Prisma ORM 7 applications.

### Features

- Schedule operations that use several PostgreSQL connections at once, such as a
  `pg.Pool` serving concurrent queries or an ORM side query beside a transaction
  (`connectionProfile: 'multi-producer-v1'`, `--connection-profile
  multi-producer-v1`). Each connection is a lane (`alice#1`) with its own ordered
  releases; lanes of one actor can wait for each other through real locks, and
  plans may name lanes. Exact replay matches connections by startup and command
  identity, so a different socket accept order still replays. Reports label
  connections only for actors that used several of them.

- Explore races inside a single statement (`overlap: 'pairs'`, `--overlap pairs`).
  A pair choice such as `alice+bob` releases two next commands together and lets
  PostgreSQL interleave them; exploration adds every unordered pair of available
  entries. Replay releases recorded pairs together again, but cannot force the
  same interleaving, so an overlap failure may reproduce only some of the time.
  Reports mark paired commands and state that their row order is not execution
  order. With it, exploration finds the Knex 0.95.12 case-study miss.

### Changes

- The default source identity budget is 128 MiB (previously 64 MiB), matching the
  export archive and verification bounds. File count (10,000) and per-file
  (16 MiB) bounds are unchanged, and every captured byte is still hashed.
  `@prisma/client` 7.10.0 alone installs 74,458,946 bytes, so the previous
  default rejected every recording that loads it.
- Multi-producer runs and runs with overlap pairs use schema version 4, which
  requires `limits.connectionProfile` and `limits.maxConnectionsPerActor`,
  permits `actor#n` and `alice+bob` plan entries, records available lanes for
  multi-producer runs, and records paired steps with `overlap`. Other
  single-producer runs keep schema version 3, and versions 1-3 read unchanged.
- The unsupported second command connection error now names the multi-producer
  profile as the alternative.
- A plan entry naming a connection that has not queued its next command becomes
  `incompatible` once nothing else can proceed for half the run deadline (at most
  5 seconds), instead of waiting for the deadline. Exploration and reduction move
  on from such a choice, and reduction keeps an inconclusive candidate's reason.
- In the multi-producer profile, a connection that has just started or completed a
  command gets up to 25 ms to queue its next one before the next decision.
- A supervised worker reports its own deadline reason, including what it was
  waiting for; the parent's backstop now follows the worker's deadline.
- A fixture capture that is not quiescent names how many other sessions were busy
  and their states.

### Fixes

- Exports in the separate installation profile pin Interleave's own dependencies
  to the versions the recording had installed. Before, a dependency release
  published after the recording made the exported runtime differ from it, and the
  export's exact replay reported `incompatible`. This started when pg-protocol
  1.16.1, pg-connection-string 2.14.1 and pg-cloudflare 1.4.1 were published on
  30 September 2026, and also affects 0.1.0.

### Qualified profiles

- Multi-connection actors (`multi-producer-v1`) with node-postgres 8.23.0 pools,
  Kysely 0.29.5 and Postgres.js 3.4.9 (`max: 2`) on PostgreSQL 16.15, 17.11 and
  18.6. See [compatibility](docs/compatibility.md#multi-connection-actors) for the
  checked cases and what remains unrun.
- Statement overlap on PostgreSQL 16.15 with node-postgres 8.23.0 and Postgres.js
  3.4.9 prepared statements, including pairs of two connections of one actor. See
  [compatibility](docs/compatibility.md#statement-overlap).
- Prisma ORM 7.10.0 with `@prisma/adapter-pg` 7.10.0 and node-postgres 8.23.0
  on PostgreSQL 16, 17 and 18 with Node.js 22.18.0 and 24.7.0, through an
  installed [checkout example](examples/prisma/README.md) whose generated client
  is recorded as source. Portable export is not supported for this client.

## 0.1.0 — 27 September 2026

The first public release. It finds, explains, replays and minimizes races in real
PostgreSQL application code, and keeps them as regression tests.

### Features

- Run existing application operations through a local PostgreSQL proxy, with
  disposable database setup, named actors and an application invariant.
- Explore observed command orders with FIFO or deterministic seeded selection.
  Report attempted and completed runs, pending work, recorded activity and
  budget stops, including incomplete evidence.
- Record exact replay inputs: selected application source, installed dependencies,
  runtime, database fixture, actor connections, released commands and lock waits.
  Use guided reruns to evaluate changed applications.
- Reduce explicit ordering choices while preserving the invariant failure, then
  export a verified regression with original dependency archives and an offline
  installation path for supported package layouts.
- Inspect standalone offline HTML reports with keyboard navigation, complete SQL,
  transaction and wait evidence, validated imports and original JSON downloads.
- Use the CLI to initialize scenarios, explore, replay, minimize, report, export,
  check the environment and run the pinned unsafe/safe neveroversell example.
- Run the pinned pghybrid public search adapters with node-postgres, Postgres.js,
  Drizzle and Kysely callers, including installed source-bound exact replay.
- Verify upstream TLS for every PostgreSQL connection: certificate chain and URL
  hostname/IP, TLS 1.2-1.3, Node.js bundled roots or a supplied CA bundle
  (`upstreamTls`, `--upstream-tls`, `--upstream-ca`, `sslmode=verify-full`).
  Setup and invariant contexts gain `connectionOptions` for additional clients.
  Actors that select SCRAM channel binding are refused explicitly.
- Run programs written in any language as actors with `processActor`. Each gets
  its actor endpoint through `DATABASE_URL` and the libpq `PG*` variables and may
  return one JSON observation on stdout. Qualified with Python and psycopg 3.3.6.
- Use TypeORM 1.1.1 or 0.3.31 actors through a per-actor DataSource helper,
  qualified for transactions, serialization-failure retry, exact replay,
  minimization and portable export on PostgreSQL 16, 17 and 18.
- Compare methods on real defects: the [case studies](docs/case-studies.md)
  reproduce three historical bugs in Knex, node-pg-migrate and Sequelize and
  measure ordinary concurrency, manual barriers and PostgreSQL's isolation
  tester on the same scenarios.

### Qualified profiles

- Native PostgreSQL 16, 17 and 18 with node-postgres 8.23.0, tested on Node.js
  22.18.0 and 24.7.0.
- Postgres.js 3.4.9 parameterized queries and transactions through the explicit
  `describe-flush-v1` profile, with its documented interruption lifecycle.
- Drizzle 0.45.2 and Kysely 0.29.5 over node-postgres; TypeORM 1.1.1 and 0.3.31
  on Node.js 22.18.0.
- Verified upstream TLS on PostgreSQL 16, 17 and 18 with Node.js 22.18.0 and
  24.7.0, against owned TLS-only servers; see the
  [qualification record](docs/qualification/verified-upstream-tls-2026-09-27.md).
- Python programs using psycopg 3.3.6 through `processActor`.
- PostgreSQL 17.11 and pgvector 0.8.6 through the explicit fixture profile,
  including the pinned pghybrid 0.1.4 search workload.
- Desktop and mobile offline reports in Chromium, Firefox and WebKit.

See [compatibility](docs/compatibility.md) for exact environments and
[validation](docs/validation.md) for dated evidence. A passing bounded
exploration does not prove an application has no races.

### Changes since the September development builds

- New run artifacts use schema version 3, with an explicit protocol profile and
  the upstream transport policy. Version 1 and 2 records stay readable; exact
  replay of them now requires a guided run, which records new evidence.
- Administrator URLs accept only PostgreSQL startup options, database aliases and
  `sslmode=verify-full`/`disable`; other query options are rejected before
  connecting. Upstream connection failures are reported with bounded messages.
- Supervised scenario workers no longer inherit libpq TLS environment settings
  such as `PGSSLMODE`; the harness supplies its resolved policy explicitly.
- Interleave's own PostgreSQL clients ignore ambient `PGSSLMODE` and related
  settings in every process. Actor endpoints and plaintext setup/invariant URLs
  now carry `sslmode=disable`, so actor drivers are not pushed into TLS by the
  environment.
- An actor proxy's upstream connection, including TLS negotiation, must complete
  within 5 seconds. A trust or negotiation failure there is a harness error.
- User names and passwords with unencoded special characters are rejected with a
  percent-encoding hint. `NODE_PG_FORCE_NATIVE` is rejected for Interleave's own
  connections because pg's native binding ignores their TLS settings.
- The per-run `timeoutMs` covers execution only. File runs capture source
  identity before and after execution under a separate 60-second bound each.
  Before, a slow capture on a loaded machine could use up the remaining run time
  and leave a finished run inconclusive.
- `interleave init` lists Interleave and pg under `devDependencies`.

### Known limits

- Interleave releases one command at a time unless PostgreSQL reports a lock
  wait, so races that need two statements executing at the same instant can be
  missed (the Knex 0.95.12 case study measures one).
- An actor holds one command-producing connection at a time; configure pools with
  a maximum of one connection per actor. COPY, pipelining and CancelRequest are
  unsupported and fail explicitly.
- Windows is not qualified. Clocks, randomness and external services are not
  controlled.
