# Changelog

## Unreleased

Interleave is in development. No stable version has been released.

### Implemented

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

### Changed

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

### Qualified profiles

- Native PostgreSQL 16, 17 and 18 with node-postgres 8.23.0, tested on Node.js
  22.18.0 and 24.7.0.
- Postgres.js 3.4.9 parameterized queries and transactions through the explicit
  `describe-flush-v1` profile, with its documented interruption lifecycle.
- PostgreSQL 17.11 and pgvector 0.8.6 through the explicit fixture profile,
  including the pinned pghybrid 0.1.4 search workload.
- Desktop and mobile offline reports in Chromium, Firefox and WebKit.
- The exact development candidate's installed CLI workflow on Node.js 22 and 24:
  scaffold, record, exact replay, reduction, report, export and offline replay.
  See the [candidate qualification](docs/qualification/canonical-package-workflow-2026-09-09.md)
  for the archive identity and execution limits.

See [compatibility](docs/compatibility.md) for completed CI results and exact
environment records, and [validation](docs/validation.md) for development evidence.
These profiles have specific protocol, source and fixture boundaries. A passing
bounded exploration does not prove an application has no races.

### Before a stable release

Recent hardening preserves unknown cleanup after an unacknowledged database
creation, applies completed-evidence checks to every exact replay entry point,
and rejects incomplete or incorrectly encoded regression artifacts. Runtime
identity also binds the CLI helpers required by exported replay commands.
Completed legacy records missing fixture or connection identities are rejected
before exact execution or export. Interrupted runs preserve application failures
observed before cancellation or cleanup began.

Pool reconnection now waits for the proxy to retire both sides of the previous
connection before admitting its replacement. The pghybrid caller helper owns
checked-out Client errors and interruption without destroying Kysely during
acquisition. Installed adapter recording and replay use the same explicit
verification budget.

Historical application cases and comparative measurements, final distribution
verification and the remaining [release checklist](docs/plans/implementation.md)
are still open. Registry installation and stable release artifacts will be
documented when they are published.
