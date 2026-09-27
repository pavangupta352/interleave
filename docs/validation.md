# Validation

Newest evidence first. Each section keeps its original date and results.

## 0.1.0 release qualification (27 September 2026)

The [v0.1.0 release](https://github.com/pavangupta352/interleave/releases/tag/v0.1.0)
comes from annotated tag object `8f5bb11cffa0702c7ea2f5195b71489dbf741473` on commit
`2e0aeede1a686089ab568f59925c5c9fcdd26288`.
[Tag CI run 36329864744](https://github.com/pavangupta352/interleave/actions/runs/36329864744)
passed all 25 jobs on Ubuntu 24.04:

- six native PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0 jobs
- six verified upstream TLS jobs over the same matrix
- six TypeORM jobs (1.1.1 and 0.3.31 × PostgreSQL 16/17/18, Node.js 22.18.0)
- two PostgreSQL 17 + pgvector 0.8.6 jobs and two managed CLI jobs
- the Python actor job and the offline report job (Chromium, Firefox, WebKit)
- the release-asset job, which built the package twice from the tagged source,
  compared the archives, inspected their contents and installed the candidate in a
  fresh consumer

The release assets are that run's artifact. Fresh downloads from the release page
match `SHA256SUMS`:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `pavangupta352-interleave-0.1.0.tgz` | 1,935,719 | `178d07ed7b604e3f05931d8af7052486c082ed6ca368adeddd091a8765de6174` |
| `interleave-0.1.0-source.tar.gz` | 873,743 | `32f87dc11f38b5fa41e1b9bd633b24e60dbae6949dfcec77440261e87e11ca08` |
| `release-manifest.json` | 73,473 | `70317b2d7ed1c9a19de3a2a8ae15881cf0e63b1da1a2f34db6d25e6303de05d8` |
| `consumer-package-lock.json` | 6,137 | `a42ca6d3acb6c290cca88110061366bfb1b2dbc25ea2c0d5db1d93abef287ed8` |

The npm archive's integrity is
`sha512-4s84XCgKUgtvC17enHUyJPA+5d7cpeo7n1b4JYgP9w8IfIqtisAWfMj0zAB9Eg2KqaF4la9z4aL3AS0Cm/5SYQ==`.
Installing the release URL with npm records that integrity.

### Consumer acceptance

The documented workflows were run against the CI-built archive of commit `ebbadbc`
on macOS arm64 with Node.js 24.7.0 (npm 11.5.1) and 22.18.0 (npm 10.9.3), one
toolchain after the other, in fresh directories with their own npm caches:
installing the release archive, `init`, `doctor`, the scaffold race, reports, the
README and application-guide record/replay/minimize commands, the CI guide's
export with offline installation and exact replay, its atomic repair with exact
and guided replay, its `node --test` check, the neveroversell demo, the Python
example from its README, and source-drift checks. Each of the 124 recorded steps
per toolchain returned its documented exit code, except one: the archive `init`
command resolved its relative path against an enclosing npm project. The 88
managed `--docker` executions (44 per toolchain) all completed as documented at
1-minute load averages up to 50 on 10 cores, with no inconclusive result. The
installed package matched the manifest in all 374 files (path, SHA-256, size and
mode).

The final commit changes only documentation after that acceptance: it passes the
archive to `npx` by absolute path and fixes four smaller documentation findings.
The final archive differs from the accepted one only in those six documentation
files; `dist` and `package.json` are byte-identical. The corrected archive route,
`doctor`, the scaffold race, its report and its exact replay were then run with
the final archive on both toolchains, from a directory inside another npm project,
and returned their documented exit codes.

### How the tag got here

The tag was created three times before this one, and nothing was published from
any of them:

1. At `8861bdd`, the full matrix passed but the release-asset job stopped on two
   packaging-rule conflicts: a public test certificate stored as `.pem`, and npm's
   `.npmignore` files. Both were fixed (`2b9fe89`, `812829c`).
2. At `812829c`, CI passed all 25 jobs, but consumer acceptance found two defects
   in the shipped Python example (its copy step broke `--include` paths, and its
   safe search needed a larger budget than the default) and 6 of 68 managed runs
   that ended inconclusive on a heavily loaded host, because re-checking source
   identity after execution shared the remaining 10-second run budget. `ffdc294`
   gave each source identity capture its own 60-second bound and fixed the example
   and documentation; `ebbadbc` aligned a release test with the scaffold, which now
   writes `devDependencies`.
3. At `ebbadbc`, CI passed all 25 jobs and consumer acceptance passed with the
   documentation findings above, which `79ce7ff`, `18da367` and `2e0aeed` fixed.

Before the second tag, the fix commit passed
[CI run 36326080068](https://github.com/pavangupta352/interleave/actions/runs/36326080068)
(24 jobs; the release-asset job runs only on tags) and, locally on macOS arm64,
776 unit tests on Node.js 24.7.0 and 22.18.0, 25 TLS tests, the offline report
checks in three browsers at two sizes, and 296 of 297 integration tests on
PostgreSQL 16 with the Python workflow included. The one failure was a 20-second
test-runner timeout for a multi-command CLI test while the host's load average was
about 40; the same test passed in CI.

npm publication of this archive is pending the owner's registry login. Until then,
install from the release page.

## Development snapshots (September 2026)

At commit `eda7290`, local integrated qualification passed **766 native tests in
57 files** on PostgreSQL 16.13, plus **288 integration tests in 36 files** on
PostgreSQL 17.11 with pgvector 0.8.6 available. The second run included native
fixtures and all 30 vector checks; it was not a vector-only selection. Both ran
under Node.js 24.7.0. Locked installation, type checking and the build passed;
the owned vector container was removed and independently confirmed absent.

The [adapter qualification](qualification/pghybrid-adapters-2026-09-09.md) records
the focused 30-check runs on Node.js 22 and 24. The [canonical package workflow](qualification/canonical-package-workflow-2026-09-09.md)
records installed CLI, offline export replay and browser acceptance for the
earlier exact `4b589db` archive. The [hardening record](qualification/replay-release-hardening-2026-09-09.md)
and earlier
[seeded-search record](qualification/seeded-search-2026-09-09.md) remain available.
The [Prisma ORM 7.10.0 record](qualification/prisma-orm-7.10.0-2026-09-27.md)
covers the installed Prisma example with the archive built from commits `418a970`
and `000224d`, on Node.js 22.18.0 and 24.7.0 against PostgreSQL 16, 17 and 18.
The [compatibility page](compatibility.md) links completed CI matrices and exact
driver, server and extension profiles. The earlier snapshots below retain their
original dates and results; their then-open limits are historical.

### Initial snapshot

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

### Later source-bound milestone

The [source-bound replay qualification](qualification/source-replay-2026-09-09.md)
records the subsequent 417-test suite, actual clean-installed replay, source and
runtime review repairs, auxiliary connection profile, and all six browser
configurations. It states the remaining export and compatibility limits.

### Historical cases and baselines

The [historical case studies](case-studies.md) record three defects that were
reported and fixed in Knex, node-pg-migrate and Sequelize, measured on
27 September 2026 with the unchanged npm releases before and after each fix on
PostgreSQL 16.15. Interleave reproduced each defect on its first run, replayed
each failure exactly 20 of 20 times and reduced each to zero explicit choices.
Ordinary concurrency, a hand-written result barrier and PostgreSQL's isolation
tester were measured on the same scenarios. The record includes a residual Knex
race that ordinary concurrency caught and Interleave's application scenario did
not, and an export defect that blocked the offline regression bundle for two of
the three cases; those two were exported and replayed through the separate
installation profile instead.

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
with its [four public adapters](qualification/pghybrid-adapters-2026-09-09.md),
and supported [shared regression installation](regressions.md) now have executed
qualification. Their documented boundaries still apply.

The historical cases and baselines above have executed measurements with the
limits recorded there, including the offline export defect for two cases. No
participant usability study has been run. The 0.1.0 GitHub release downloads
were verified against their recorded hashes; npm publication is pending. Other drivers, extensions and platforms need their own
evidence before support claims expand. The
[implementation checklist](plans/implementation.md) tracks the remaining work.
