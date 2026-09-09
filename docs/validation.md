# Development validation

The local integrated replay and cleanup hardening qualification passed **754 native
tests in 56 files**, plus **ten pgvector checks**, build and type checks. See the
[hardening record](qualification/replay-release-hardening-2026-09-09.md) for its
exact source and scope. The earlier
[seeded-search record](qualification/seeded-search-2026-09-09.md) remains available.
The [compatibility page](compatibility.md) links completed CI matrices and exact
driver, server and extension profiles. The earlier snapshots below retain their
original dates and results; their then-open limits are historical.

## Initial snapshot

This records the executed initial development snapshot, commit `9e71b06`, on
9 September 2026. It does not qualify a stable release or every PostgreSQL driver.

| Check | Executed result |
| --- | --- |
| Clean dependency installation | Locked install; no reported npm audit vulnerabilities |
| Type checking and production build | Passed in a fresh directory containing the staged source |
| Unit and real-database suite | 263 tests passed across 26 files |
| Database and driver | PostgreSQL 16.13, node-postgres 8.23.0 |
| Runtime | Node.js 24.7.0 |
| Browser behavior | 12 checks passed in each of Chromium, Firefox and WebKit at 1440×1000 and 390×844 |
| Package contents | 173 files; expected CLI, library, offline assets and third-party notices present; private working files excluded |

The full suite includes original application queries, query fragmentation,
prepared statement recovery, real lock waits, transaction errors, unique database
ownership, interrupted workers, bounded evidence, incompatible replay, reduction
fixture drift, hostile artifact data and clean-installed regression exports.
Export tests check that installing Interleave does not upgrade the application's
independently locked node-postgres dependency.

Browser tests create a real `neveroversell` violation before opening the report.
They check recorded identities, invalid schema and UTF-8 imports, file limits,
inert hostile text, exact JSON download, pagination, keyboard navigation,
filtering, empty evidence, runtime errors and unexpected network requests.

The README screenshot is an actual run of the unchanged unsafe `naiveBuy`
operation with `gapMs: 0`. It is a constructed demonstration owned by this
maintainer, not an independent historical production bug.

## Later source-bound milestone

The [source-bound replay qualification](qualification/source-replay-2026-09-09.md)
records the subsequent 417-test suite, actual clean-installed replay, source and
runtime review repairs, auxiliary connection profile, and all six browser
configurations. It states the remaining export and compatibility limits.

## Repeating the checks

With Docker available:

```sh
npm ci
npm run check
npx playwright install --with-deps chromium firefox webkit
npm run test:browser
npm pack --dry-run
```

The test commands build the runtime before running parallel tests. They manage
their own disposable PostgreSQL instance unless `TEST_DATABASE_URL` explicitly
selects a dedicated test administrator database. See the [README](../README.md)
for lifecycle and connection details.

## Open qualification gates

The [native PostgreSQL matrix](qualification/postgresql-native-matrix-2026-09-09.md),
[Postgres.js profile](qualification/postgresjs-describe-flush-2026-09-09.md),
[pgvector/pghybrid workload](qualification/postgresql17-pgvector-pghybrid-2026-09-09.md)
and supported [shared regression installation](regressions.md) now have executed
qualification. Their documented boundaries still apply.

Three independent historical bug/fix pairs, comparative measurements and final
release/download verification remain unfinished. Other drivers, extensions and
platforms need their own evidence before support claims expand. The
[implementation checklist](plans/implementation.md) tracks the remaining work.
