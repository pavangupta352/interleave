# Historical cases

This directory holds three concurrency defects that were reported and fixed in
open-source Node.js PostgreSQL libraries. Each case runs the library's unchanged
public API from
the npm release published before the fix and from the first release that
contains it. The measured results, including what each method missed, are in
the [case studies](../../docs/case-studies.md).

| Case | Defect before the fix | Upstream fix | Releases |
| --- | --- | --- | --- |
| [Knex migration lock](knex-migration-lock/README.md) | Two processes can both see an empty lock table and insert two lock rows | [knex/knex#4694](https://github.com/knex/knex/pull/4694) | 0.95.11 → 0.95.12 |
| [node-pg-migrate bootstrap](node-pg-migrate-bootstrap/README.md) | Two runners can both find no migrations table; the second `CREATE TABLE` fails | [salsita/node-pg-migrate#830](https://github.com/salsita/node-pg-migrate/pull/830) for [#821](https://github.com/salsita/node-pg-migrate/issues/821) | 5.10.0 → 6.0.0 |
| [Sequelize findCreateFind](sequelize-find-create-find/README.md) | Inside a PostgreSQL transaction, the losing insert aborts the transaction and the retry lookup fails | [sequelize/sequelize#13482](https://github.com/sequelize/sequelize/pull/13482) | 6.7.0 → 6.8.0 |

These are libraries' own historical defects, not constructed examples. Each
scenario sets up a starting state, calls the library the way an application
would, and asserts the failure that the upstream report describes. The
scenarios replace no library code, driver, SQL, clock or random source. The
test-only instrumentation used by the barrier baseline and the Knex blocker
scenario is named where it is used. The libraries install
from the public npm registry under their own MIT licenses; nothing from them is
copied into this repository.

## Layout

Each case directory contains:

- `before-fix/` and `after-fix/`: small npm applications with a committed
  lockfile and an identical `scenario.mjs`. Only the library version differs.
  The Knex case also has `later-release/` for its current release.
- `barrier.mjs`: the statement boundary used by the manual-barrier baseline.
- `isolation/*.spec`: the relevant SQL transcribed for PostgreSQL's isolation
  tester, with the tester's output for each spec in a matching `.out` file.

Shared tools:

- [`harness/baseline.mjs`](harness/baseline.mjs) runs a scenario's own setup,
  actors and invariant without Interleave, either with no coordination
  (`--mode ordinary`) or with the hand-written result barrier in
  [`harness/result-barrier.mjs`](harness/result-barrier.mjs) (`--mode barrier`).
- [`isolation/Dockerfile`](isolation/Dockerfile) builds `isolationtester` from
  the PostgreSQL release that matches the server, and
  [`isolation/run-spec.mjs`](isolation/run-spec.mjs) runs one spec in a new
  generated database.

The lockfiles resolve the libraries' current transitive dependencies. They are
the 2021 library releases on a 2026 dependency set, not a reconstruction of a
2021 environment. All three use node-postgres 8.23.0.

## Run a case

Use Node.js 22.18 or newer and a dedicated PostgreSQL server where the
administrator may create and drop databases. Every execution creates its own
generated database and removes it afterwards.

From a built Interleave checkout (`npm ci && npm run build`), copy a case
outside the checkout, install it, and run it with the checkout's CLI:

```sh
mkdir -p ../interleave-historical
cp -R examples/historical/knex-migration-lock ../interleave-historical/
case=../interleave-historical/knex-migration-lock
npm ci --prefix $case/before-fix

export TEST_DATABASE_URL='<dedicated PostgreSQL administrator URL>'
node dist/cli.js run $case/before-fix/scenario.mjs --timeout-ms 30000 --out knex-failure.interleave.json
```

A detected violation exits 1. Instead of a URL, add `--docker` to each execution
command to let Interleave manage a local PostgreSQL 16 server. Each case README
lists the replay, reduction and repaired-version commands.

Install the cases outside the checkout. Interleave's package includes the
`examples` directory, so a `node_modules` directory created inside it would be
included by a later `npm pack` of the checkout.

The measurements used a different route: each `before-fix/` and `after-fix/`
directory was copied out as an ordinary application, and the packed Interleave
archive was installed into it with `npm install --save-exact <archive>`, as in
[getting started](../../docs/getting-started.md#install-a-source-build-into-an-application).

## Keep a portable regression

A recording made with the checkout's CLI exports through the separate
installation profile. Its bundle installs the application and Interleave with
ordinary `npm ci`, so it needs the npm registry or a populated npm cache:

```sh
node dist/cli.js export $case/before-fix/scenario.mjs knex-failure.interleave.json \
  --project-root $case/before-fix --out knex-regression
```

Run the install and replay commands that export prints from inside
`knex-regression`. Keep the checkout free of installed `node_modules` under
`examples/`; export packs the checkout's runtime and fails if its file list is
too large.

For a bundle that installs offline, install the packed Interleave archive into
the copied application and export with `--runtime-archive <archive>`; see
[regression exports](../../docs/regressions.md). In the current development
build this works for the Knex case but not for the node-pg-migrate and
Sequelize cases: their lockfiles contain `@types/*` packages, whose registry
archives do not use npm's usual `package/` directory, and export rejects them.
The [case studies](../../docs/case-studies.md#findings-about-interleave) record
this defect.

## Run the baselines

The baseline harness takes a scenario file and uses that scenario's own
installed driver. It and the isolation runner need `TEST_DATABASE_URL`; they do
not start a server:

```sh
node examples/historical/harness/baseline.mjs --scenario $case/before-fix/scenario.mjs \
  --mode ordinary --trials 100

node examples/historical/harness/baseline.mjs --scenario $case/before-fix/scenario.mjs \
  --mode barrier --barrier $case/barrier.mjs --trials 20
```

Each trial prints one JSON line with its outcome, actor results, timings and
cleanup check; the last line is a summary. `ordinary` starts every actor in the
same event-loop turn and adds nothing else. `barrier` withholds the result of one
named statement from each actor until all actors have reached it or finished,
then delivers the results together.

Build the isolation tester for the server's exact version, then run a spec. For
a server in a Docker container, share that container's network:

```sh
docker build -t interleave-isolationtester:16.15 \
  --build-arg BASE_IMAGE=postgres:16 --build-arg PG_VERSION=16.15 \
  --build-arg PG_SHA256=c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed \
  examples/historical/isolation

node examples/historical/isolation/run-spec.mjs \
  --spec $case/isolation/before-fix.spec \
  --image interleave-isolationtester:16.15 \
  --network container:<PostgreSQL container name> --host 127.0.0.1 --port 5432
```

Use the version and checksum published with the matching
[PostgreSQL source release](https://www.postgresql.org/ftp/source/). `run-spec.mjs`
creates and drops the generated database with the node-postgres installed in the
case's `before-fix/` directory, or the one named by `--driver`.

## Boundaries

Each result applies to its named releases, scenario and environment. A published
release can contain other changes besides the fix; each case README identifies
the files on the exercised path that match the upstream commits. Ordinary
concurrency rates depend on the machine and its load. A passing bounded search
or a passing isolation permutation does not show that a library is race-free;
the Knex case records a fix that passed both while ordinary concurrency still
failed.
