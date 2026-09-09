# Command-line interface

The CLI is under development. These commands execute the implemented core;
broader driver, environment and release qualification remains in progress.

Use Node.js 22.18 or newer. Scenario files are trusted executable code. Production
fixtures should be runnable `.mjs`/ESM files with their own installed dependencies.
The installed CLI does not provide tsx or custom TypeScript loaders. Source-mode
development tests use tsx separately.

Use [getting started](getting-started.md) to acquire the current unpublished
development build and configure PostgreSQL. Commands below use an installed
application's `npx --no-install interleave`. In a built source checkout, replace
that prefix with `node dist/cli.js`. See [troubleshooting](troubleshooting.md)
for setup failures and outcome-specific next steps.

## Start a project

```sh
npx --no-install interleave init ../race-check
```

`init` creates `scenario.mjs`, `package.json`, and `README.md`. It never installs
packages or overwrites existing files. Install the original local Interleave
archive into that new project using the [complete development-package route](getting-started.md#install-this-development-build-into-an-application).
There is no published development version promised by this guide.

## Select PostgreSQL

Use `--docker` on `run`, `replay`, `minimize`, `doctor` or `demo` to start an owned
local server and remove it after the command. The first invocation may download
the image. Each execution still creates and cleans up a separate generated
database. `report`, `export` and `init` never start a server.

`--postgres-image` requires `--docker` and accepts exactly `postgres:16`,
`postgres:17`, `postgres:18`, or `pgvector/pgvector:0.8.6-pg17-bookworm`.
The default is `postgres:16` for the native fixture profile and the vector image
for the explicit pgvector profile. An incompatible image/profile combination
is rejected. `--docker` also rejects `--database-url` and a nonempty
`TEST_DATABASE_URL`; unset the variable when choosing managed Docker.

Alternatively, set `TEST_DATABASE_URL` to the administrator database of a **dedicated test
PostgreSQL server** with permission to create and drop databases, or pass
`--database-url <url>` explicitly. No existing server is selected implicitly.
Every execution creates and cleans up a separate generated database; the supplied
server remains running. The execution examples below assume this URL route.
To use managed Docker, unset `TEST_DATABASE_URL` and add `--docker` to each
execution command. Report and export need neither route.

## Discover, replay, and reduce

```sh
npx --no-install interleave run scenario.mjs --max-runs 50 --out failure.interleave.json
npx --no-install interleave replay scenario.mjs failure.interleave.json
npx --no-install interleave minimize scenario.mjs failure.interleave.json --out reduced.interleave.json
```

`run` explores observed actor-choice prefixes. Every attempt runs in a supervised
worker. It stops at the first invariant violation by default; `--keep-going`
continues within the selected limits. `--plan alice,bob,alice,bob` supplies the
initial actor-choice prefix. Sampled success does not prove race freedom.

A detected invariant violation exits 1, including a successful replay or completed
minimization of that failure. A shell with `set -e` would stop there. The
[application walkthrough](application-guide.md#record-inspect-and-replay) checks
expected statuses explicitly; do not suppress all failures with `|| true`.

The default `--strategy fifo` selects the oldest pending prefix. Use `--seed 42`
to select a repeatable seeded search order, or explicitly combine
`--strategy seeded --seed 42`. Seeds are decimal integers from 0 through
4,294,967,295; zero is valid. Explicit FIFO with a seed, or seeded selection
without a seed, is rejected. These flags apply only to `run`.

```sh
npx --no-install interleave run scenario.mjs --seed 42 --max-runs 50 --json > search.json
```

The search summary records the effective strategy and seed, attempted and
completed runs, pending prefixes, maximum attempted prefix depth, recorded
release units and actor switches. Counts include validated attempts omitted
from retained results. If any attempt has incomplete evidence, the human summary
labels the trace counts as lower bounds; JSON reports
`metrics.traceCountsComplete: false`. A release unit is not a SQL-statement or
affected-row count. See the [metric definitions](api.md#search-selection-and-measurements).

A seed selects pending work when the observed choices are the same. It does not
freeze external effects, database execution or elapsed-time budget cutoffs.
Preserve a run artifact for exact replay; replay does not accept a seed.

`--out` writes one validated RunResult artifact: the first retained violation,
or otherwise the last retained run. Search summary JSON is a different object
and is not a replay artifact. Writes are atomic and refuse existing destinations.
Use another filename or explicitly add `--force` to replace an output. The parent
directory must exist. A search which retains no run cannot write a run artifact;
its machine-readable result reports the budget stop and omitted runs.

Exact replay is the default. Changed source, installed dependencies, runtime,
fixture, connection profile or command identity produces an incompatible result.
`replay --guided` explicitly
creates separately labeled new evidence using the old actor order; it does not
claim exact replay compatibility.

Guided mode still requires the requested order to be feasible and fully consumed.
If a repair removes commands, the old order can also be incompatible in guided
mode. The [repair example](ci.md#try-an-atomic-repair-as-new-evidence) demonstrates
that case and uses fresh exploration for the new behavior.

`minimize` first verifies the recorded failure and reduces explicit schedule
choices while retaining the same invariant failure. Its initial verification
counts against `--max-attempts`. A locally minimal result is about removing
schedule choices under the runner's fallback policy, not changing application SQL
or finding a globally shortest execution.

A hard failure in a reduction trial stops reduction. The result retains the
last verified violation separately from `attemptFailure`, which reports the
trial outcome, reason and cleanup recovery details. Such a result exits with 2;
it is not a completed reduction.

File runs capture their local module graph and installed dependencies before
loading the scenario, then check them again afterward. Use `--project-root <dir>`
to choose a portable root and repeated `--include <relative-path>` arguments for
data files read outside the import graph. Declare these paths when recording the
failure. Replay and reduction inherit the recorded selection. See the
[file identity contract](api.md#file-identity).

`--max-connections-per-actor <1..8>` permits a bounded number of physical
connections for each actor. The default is one. Additional live connections must
remain queryless; a second live command producer is explicitly unsupported. Exact
replay and reduction inherit the recorded cap.

`--protocol-profile describe-flush-v1` enables drivers that request metadata with
Parse/Describe/Flush before sending parameter values. A description and its later
execution are separate releases, each counted by `--max-steps`. The default
`sync-cycle-v1` retains whole simple-query or extended-through-Sync cycles.
Replay and reduction inherit the recorded protocol. See the [Postgres.js
example](../examples/postgresjs/README.md) for driver setup and cancellation.

`--fixture-profile postgresql17-pgvector0.8.6-v1` selects the separate PostgreSQL
17 / pgvector 0.8.6 catalog contract. It requires that exact extension version in
`public`, owned by the capture role. The default `native` profile permits
`plpgsql` and rejects other extensions. Exact replay rejects an explicit profile
change before importing the scenario; guided replay records new evidence.

## Inspect and retain a regression

```sh
npx --no-install interleave report failure.interleave.json --out failure.html
npx --no-install interleave export scenario.mjs failure.interleave.json --project-root . --out regression
```

The [offline report](reports.md) opens without a server and does not execute code.
The [regression export](regressions.md) copies explicitly selected source files,
the package lock and the recorded built runtime into a verified bundle. The
selected files must still match the failure record. Additional data inputs must
be declared when recording; export inherits that selection.
Review the printed install and replay steps; export itself does not install or
execute the copied project. Neither command requires a database URL.

For a recorded shared app installation, `--runtime-archive <original.tgz>` and
repeated `--dependency-archive <original.tgz>` arguments supply original archives
whose integrity must match the recorded npm lock. The shared installer restores
that original graph from bundled archives in a fresh private offline cache.
An arbitrary repack does not substitute for the original archive.

## Check the environment and run the demo

```sh
npx --no-install interleave doctor
npx --no-install interleave demo neveroversell --out neveroversell.interleave.json
npx --no-install interleave demo neveroversell --safe
```

`doctor` creates its own disposable database, performs two real parameterized
queries through actor proxies, verifies the observations, and cleans up. It
reports the observed PostgreSQL and Node versions. This check does not certify
all PostgreSQL features or application drivers.

Use `doctor --json` when collecting the actual environment and cleanup fields
for a [bug report](troubleshooting.md#report-a-reproducible-problem).

`demo` runs the pinned, vendored neveroversell application code in supervised
workers. The default scenario deliberately oversells one unit with two buyers
through the original `naiveBuy` implementation; it should report a violation.
`--safe` uses the original reservation API and expects one held reservation and
one insufficient-capacity result. This is a constructed demonstration, not a
historical production bug. The packaged runtime includes the original SQL,
source provenance, and license notices and needs no TypeScript loader.

## Limits and machine output

Common execution limits are `--max-steps`, `--timeout-ms`, and
`--max-evidence-bytes`. Exploration also accepts `--max-runs`,
`--total-timeout-ms`, `--max-candidates`, and `--max-search-bytes`. Reduction accepts
`--max-attempts` and `--total-timeout-ms`. Values are integer counts, bytes, or
milliseconds as named. Defaults and supported contracts are in [API](api.md).

Choose execution limits for each invocation. Replay does not inherit the recorded
timeout: if recording needed `--timeout-ms 30000`, pass that option again when
replaying or minimizing. Omitting it selects the default 10-second per-run limit.

`--json` writes one JSON value to stdout: the corresponding public API result
(ExplorationResult for run, RunResult for replay/doctor/demo, MinimizationResult
for minimize). Usage failures produce an object containing `error.message` and
`exitCode`. Arbitrary scenario logs are discarded by supervision and do not enter
this channel. `--help` and `--version` need no database.

Private artifacts preserve exact SQL, errors, and explicitly selected actor
observations. Those fields may contain sensitive application data. The harness
does not intentionally record authentication messages, backend cancellation
keys, or raw application logs. Review evidence before sharing it.

| Exit code | Meaning |
| ---: | --- |
| 0 | Checked run passed, or the modeled exploration frontier was exhausted without a violation |
| 1 | An invariant violation was observed; a completed minimization still reproduces its violation |
| 2 | Invalid usage, actor failure, harness error, output error, or incomplete cleanup |
| 3 | Incompatible replay, or exploration with no compatible completed execution |
| 4 | Inconclusive execution or a search/reduction safety budget stopped work |
| 130 | SIGINT cancellation, after owned cleanup |
| 143 | SIGTERM cancellation, after owned cleanup |

A safety-budget stop returns 4 even when retained earlier runs include a
violation. Its JSON result still records those observations. An actor/harness
failure or incomplete cleanup takes priority over a search budget status.

Cancellation asks the supervised worker to stop and escalates to termination.
Database creation and cleanup have their own bounds and may extend beyond an
execution deadline. POSIX cleanup owns the worker's process group; Windows
cleanup owns the worker itself. Detached application processes and other
external effects remain the trusted scenario's responsibility. This is lifecycle
isolation, not a sandbox.
