# Validation

Newest evidence first. Each section keeps its original date and results.

## 0.3.1 release qualification (25 October 2026)

The [v0.3.1 release](https://github.com/pavangupta352/interleave/releases/tag/v0.3.1)
comes from annotated tag object `ea97b78c80d24a73b0477fa62c4fb72a2b475f55` on commit
`6bb23b1d046cfbff66c71884c11c6506f3c18fd7`.
[Tag CI run 40177590284](https://github.com/pavangupta352/interleave/actions/runs/40177590284)
passed all 82 jobs. Every job with a Node.js matrix ran on 22.18.0, 24.7.0 and
26.12.1, and the Node.js 26.12.1 jobs used npm 12.2.1:

- nine native PostgreSQL 16/17/18 × Node.js jobs, 1,304 tests each
- nine verified upstream TLS jobs over the same matrix
- three Windows Server 2025 jobs (738 unit and 336 integration tests each) and
  three macOS 15 jobs (956 and 348), with PostgreSQL 17
- six TypeORM jobs on Node.js 22.18.0, nine Prisma ORM 7.10.0 jobs and twenty-seven
  Sequelize, Knex and MikroORM rows
- the Python (four legs), Ruby, PHP, Go and Java actor jobs on Node.js 24.7.0, three
  PostgreSQL 17 + pgvector 0.8.6 jobs and three managed CLI jobs
- the offline report job, 81 checks at each desktop and mobile size in Chromium,
  Firefox and WebKit
- the release-asset job, which built the package twice from the tagged source,
  compared the archives, inspected their contents and installed the candidate in a
  fresh consumer

The release assets are that run's artifact (ID 12593865975). Fresh downloads from
the release page match `SHA256SUMS`:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `pavangupta352-interleave-0.3.1.tgz` | 2,103,316 | `b1b26b38e0500094b650aab9ec74106990baac229823d09141c5cf1b94492ae1` |
| `interleave-0.3.1-source.tar.gz` | 1,125,669 | `fc8355ee48bb73f567b055a3d0b4728bbfbc07f1b3a23908e7fe7558a5eccba2` |
| `release-manifest.json` | 97,166 | `aa2c395999f48dd3483e4c2490dea186e58bf6e8ac443eab7cf9fede7ddd6b41` |
| `consumer-package-lock.json` | 6,137 | `344d2d2d81f44a0635f981c777c550986327ac4bcb724e57691d90a0007afa9c` |

The npm archive's integrity is
`sha512-52JQzep5QO7bQSaEhEUNCFpM+YMcyjrrWJcmguGsnP1bs2s+Jy84jeJ62BW5UyZyLFeePv12LF/QlJ7SdOH5iA==`.
The release script, run on Apple silicon for the same commit, produced the same tar
stream as this archive; the gzip bytes differ because Node.js's bundled zlib picks
CPU-specific code (see [preparing a release](releasing.md)).

### Consumer acceptance

The documented workflows were run against the CI-built archive on macOS arm64 with
Node.js 22.18.0 (npm 10.9.3), 24.7.0 (npm 11.5.1) and 26.12.1 (npm 12.2.1), against
PostgreSQL 16.15, in fresh directories with their own npm caches. The gate recorded
464 steps (84 on Node.js 22.18.0, 116 on 24.7.0 and 264 on 26.12.1), and every
command that comes from a README or guide returned its documented exit code on the
first attempt:

- On all three toolchains: the README install and `doctor`, the getting-started
  workflow (`init`, install, `doctor`, the scaffold race and report), the README
  counter commands, an export with `--runtime-archive` that installed offline and
  replayed exactly, and the cursor example.
- On Node.js 26.12.1: a fresh build of the tag recorded the Knex migration-lock case
  in an application without Interleave and exported it without
  `--runtime-archive`, so export packed the runtime with npm 12; the export installed
  and replayed the failure. The Sequelize, Knex and MikroORM gates passed 14 of 14
  checks each, and the Prisma example ran as documented, its repaired search
  covering 363 of 363 schedules.
- On Node.js 24.7.0: the Python and Go examples, with 47 and 295 repaired schedules.
- The 0.3.0 gate's finding about replays that stop mid-run: with the scaffold's new
  `'error'` listener, a changed COPY input made exact replay report `incompatible`
  (exit 3); without the listener it reported `harness-error` (exit 2).
- The existing-output refusals name `--force`.

The installed package matched the manifest in all 501 files (path, SHA-256, size
and mode). The gate's findings were documentation notes, fixed after the release:
the API reference and the application example now give their clients an `'error'`
listener, the README pins node-postgres 8.23.0, and the export guide and ORM
examples name the qualified npm and Node.js versions. The gate did not cover the
npm registry route, PostgreSQL 17 and 18, verified TLS, or hosts other than macOS
arm64; CI covers those it can.

After publication, fresh downloads from the release page matched `SHA256SUMS`, and
the README and getting-started commands ran as written against the release with
Node.js 26.12.1 and npm 12.2.1. Publishing the release started
[publish run 40183139172](https://github.com/pavangupta352/interleave/actions/runs/40183139172):
it found the tag's successful CI run, rebuilt the tagged source on GitHub's runner,
matched the release archive's package contents and skipped the npm publish because
the package is not on npm yet. npm publication of this archive is pending the
owner's registry login.

## 0.3.0 release qualification (25 October 2026)

The [v0.3.0 release](https://github.com/pavangupta352/interleave/releases/tag/v0.3.0)
comes from annotated tag object `65eb1c8c455b576aed7a2ab2e7bcc9e29774c529` on commit
`b803e65a3723dcb1ab41df8516e8101338c966db`.
[Tag CI run 40160347133](https://github.com/pavangupta352/interleave/actions/runs/40160347133)
passed all 60 jobs:

- six native PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0 jobs, 1,304 tests each
- six verified upstream TLS jobs over the same matrix
- two Windows Server 2025 jobs (738 unit and 336 integration tests each) and two
  macOS 15 jobs (956 and 348), on Node.js 22.18.0 and 24.7.0 with PostgreSQL 17
- six TypeORM jobs, six Prisma ORM 7.10.0 jobs and eighteen Sequelize, Knex and
  MikroORM rows
- the Python (four legs), Ruby, PHP, Go and Java actor jobs, two PostgreSQL 17 +
  pgvector 0.8.6 jobs and two managed CLI jobs
- the offline report job, 81 checks at each desktop and mobile size in Chromium,
  Firefox and WebKit
- the release-asset job, which built the package twice from the tagged source,
  compared the archives, inspected their contents and installed the candidate in a
  fresh consumer

The release assets are that run's artifact. Fresh downloads from the release page
match `SHA256SUMS`:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `pavangupta352-interleave-0.3.0.tgz` | 2,099,090 | `cd598f66915553b93b8ec7a3f4477cd89b3c7bfbef0f2e1b03ebf6c5d2f8d17d` |
| `interleave-0.3.0-source.tar.gz` | 1,119,208 | `0a66e1b91522aa8cd7adf678ab29e4b8f3574c72ddebb493a35bb505ff0b3452` |
| `release-manifest.json` | 97,166 | `807a8bf6c7d03cebecde47eb601111ed4299237fa1d91152d236983293a2a8ab` |
| `consumer-package-lock.json` | 6,137 | `79ec553f1d857be546e0b874054759cff05e7096c0b24c51adbbfb6cc0ada588` |

The npm archive's integrity is
`sha512-O3DAXDX7KmRGci5i7qVnnZimFTZCGrKFFOtIIgmU82J0XpcHw10+qDpuZrVBaD1NBAh+z2X1MSAwVYocaFvWVQ==`.
Installing the release URL with npm records that integrity, and the getting-started
commands ran as written against the published release.

### Consumer acceptance

The documented workflows were run against the CI-built archive on macOS arm64 with
Node.js 24.7.0 (npm 11.5.1) and 22.18.0 (npm 10.9.3), against PostgreSQL 16, in
fresh directories with their own npm caches. All 446 recorded commands (355 on
Node.js 24.7.0 and 91 on 22.18.0) that come from a README or guide returned their
documented exit codes on the first attempt:

- The core workflow on both toolchains: release install, `init`, `doctor`, the
  scaffold race and report, the README counter commands, and an export that
  installed offline and replayed exactly.
- The cursor example on both toolchains, and the pool and overlap examples. All
  10 exact replays of the pool recording repeated the violation.
- The ten language examples. The repaired searches matched their READMEs: Python
  47, Ruby 47, PHP 619, Go 295, Java 183, asyncpg 295 and Django 295 schedules.
  SQLAlchemy, Active Record and GORM each ran 200 seeded orders with no violation.
- The Sequelize, Knex and MikroORM gates, 14 of 14 checks each, including export.
- The Prisma example on Node.js 22.18.0; its repaired search covered 363 schedules.
- New scenarios written against the installed package: a Postgres.js
  `query.cancel()` and a pg-copy-streams COPY FROM STDIN both recorded, replayed
  and showed the cancel request and the COPY transfer in their reports.
- Interrupting a run: SIGHUP exited 129 and SIGINT 130, with a dedicated server and
  with `--docker`, and the run's database or managed container was gone each time.

The installed package matched the manifest in all 501 files (path, SHA-256, size
and mode). The gate's findings were documentation notes and one message wording,
fixed after the release. It did not cover the npm registry route (the package is
unpublished), PostgreSQL 17 and 18 or Windows (CI covers them), or hosts other
than macOS arm64.

npm publication of this archive is pending the owner's registry login. Until then,
install from the release page.

## 0.2.1 release qualification (25 October 2026)

The [v0.2.1 release](https://github.com/pavangupta352/interleave/releases/tag/v0.2.1)
comes from annotated tag object `2016eb87d21f7e54747bbd9890ec1d7d80bf30e0` on commit
`5b54b508eb0541d98c09b5f152143dc7f516b017`.
[Tag CI run 40151506663](https://github.com/pavangupta352/interleave/actions/runs/40151506663)
passed all 31 jobs on Ubuntu 24.04:

- six native PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0 jobs
- six verified upstream TLS jobs over the same matrix
- six TypeORM jobs (1.1.1 and 0.3.31 × PostgreSQL 16/17/18, Node.js 22.18.0)
- six Prisma ORM 7.10.0 jobs (PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0)
- two PostgreSQL 17 + pgvector 0.8.6 jobs and two managed CLI jobs
- the Python actor job and the offline report job (Chromium, Firefox, WebKit)
- the release-asset job, which built the package twice from the tagged source,
  compared the archives, inspected their contents and installed the candidate in a
  fresh consumer

The release assets are that run's artifact. Fresh downloads from the release page
match `SHA256SUMS`:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `pavangupta352-interleave-0.2.1.tgz` | 2,014,329 | `75240e2e428f2ad9c0c3a7bb90e8a4dea0e1358e26c15c4b89e3a6f5813896d7` |
| `interleave-0.2.1-source.tar.gz` | 978,993 | `4c859de379b16fc8002d609dfc966cf04cbdfc47dc47a870870bf4fd5e9e589c` |
| `release-manifest.json` | 79,449 | `f5e9ad48ca9b5aa5a8d5c316ef629f845f47f9085ac5e78c716c357ae90ed54a` |
| `consumer-package-lock.json` | 6,137 | `3ae5e088438dae0aa0f713aa3c325f3eab47725746aa76273ef7775464d3a390` |

The npm archive's integrity is
`sha512-l00kMjubOgsgVxb6BFuP82HSbfUvFWkrvACQDKnLWEvSqHH7z7PTx3ObJcWOjKiT/4dX/xEgpzvLjpnSvs1X1A==`.
Installing the release URL with npm records that integrity.

### Consumer acceptance

The documented workflows were run against the CI-built archive on macOS arm64 with
Node.js 24.7.0 (npm 11.5.1) and 22.18.0 (npm 10.9.3), one toolchain after the
other, in fresh directories with their own npm caches, against PostgreSQL 16.15.
They covered the release-archive install route, `init`, `doctor`, the scaffold
race and its report, the README counter commands, an export with
`--runtime-archive` that installed offline with outbound network denied and
replayed exactly, the pool, overlap, Python and Prisma examples, and the Knex
0.95.12 case study with `--overlap pairs`. All 266 recorded commands (133 per
toolchain) returned their documented exit codes on the first attempt:

- The pool example's repaired search exhausted 41 schedules.
- All 12 paired searches of the overlap example found the double claim on their
  third run, and 20 of 20 exact replays repeated it.
- The Python example's repaired search exhausted 47 schedules.
- The Prisma example's repaired search exhausted 363 schedules.
- The Knex case's paired search found the duplicate lock row on its seventh run
  with both toolchains, and 10 of 10 exact replays per toolchain repeated it.

The installed package matched the manifest in all 406 files (path, SHA-256, size
and mode). The six findings were documentation notes, fixed in the commit that
records this release. The gate did not cover the npm registry route (the package
is unpublished), PostgreSQL 17 and 18 (CI covers them), or hosts other than
macOS arm64.

### How the tag got here

The `v0.2.0` tag on commit `201f3b7` was never released. Its
[tag CI run 40139424454](https://github.com/pavangupta352/interleave/actions/runs/40139424454)
passed every test job, but the release-asset job stopped because npm leaves nested
`.gitignore` files out of a package and the Prisma example kept one, so the packed
archive differed from the tagged source. `6aaba40` moved that rule to the
repository root, and `6a6e67b` made a pgvector test wait for the driver's query
before interrupting it. The line was released as 0.2.1 rather than by moving the
`v0.2.0` tag.

npm publication of this archive is pending the owner's registry login. Until then,
install from the release page.

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
