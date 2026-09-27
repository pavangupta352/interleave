# Changelog

## Unreleased

### Features

- Schedule operations that use several PostgreSQL connections at once, such as a
  `pg.Pool` serving concurrent queries or an ORM side query beside a transaction
  (`connectionProfile: 'multi-producer-v1'`, `--connection-profile
  multi-producer-v1`). Each connection is a lane (`alice#1`) with its own ordered
  releases; lanes of one actor can wait for each other through real locks, and
  plans may name lanes. Exact replay matches connections by startup and command
  identity, so a different socket accept order still replays. Reports label
  connections only for actors that used several of them.

### Changes

- Multi-producer runs use schema version 4, which requires
  `limits.connectionProfile` and `limits.maxConnectionsPerActor`, permits
  `actor#n` plan entries and records available lanes. Single-producer runs keep
  schema version 3, and versions 1-3 read unchanged.
- The unsupported second command connection error now names the multi-producer
  profile as the alternative.

### Qualified profiles

- Multi-connection actors (`multi-producer-v1`) with node-postgres 8.23.0 pools,
  Kysely 0.29.5 and Postgres.js 3.4.9 (`max: 2`) on PostgreSQL 16.15, 17.11 and
  18.6. See [compatibility](docs/compatibility.md#multi-connection-actors) for the
  checked cases and what remains unrun.

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
