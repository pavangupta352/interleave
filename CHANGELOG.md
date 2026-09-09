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
- Run the pinned pghybrid `forPg` compatibility example from source or the compiled
  package, including file-bound exact replay.

### Qualified profiles

- Native PostgreSQL 16, 17 and 18 with node-postgres 8.23.0, tested on Node.js
  22.18.0 and 24.7.0.
- Postgres.js 3.4.9 parameterized queries and transactions through the explicit
  `describe-flush-v1` profile, with its documented interruption lifecycle.
- PostgreSQL 17.11 and pgvector 0.8.6 through the explicit fixture profile,
  including the pinned pghybrid 0.1.4 search workload.
- Desktop and mobile offline reports in Chromium, Firefox and WebKit.

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

Historical application cases and comparative measurements, final distribution
verification and the remaining [release checklist](docs/plans/implementation.md)
are still open. Registry installation and stable release artifacts will be
documented when they are published.
