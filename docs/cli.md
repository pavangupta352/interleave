# Command-line interface

The CLI is under development. These commands execute the implemented core;
broader driver, environment and release qualification remains in progress.

Use Node.js 22.18 or newer. Scenario files are trusted executable code. Production
fixtures should be runnable `.mjs`/ESM files with their own installed dependencies.
The installed CLI does not provide tsx or custom TypeScript loaders. Source-mode
development tests use tsx separately.

## Start a project

```sh
interleave init race-check
cd race-check
npm install
```

`init` creates `scenario.mjs`, `package.json`, and `README.md`. It never installs
packages or overwrites existing files. A development version may need installation
from a locally built Interleave tarball instead of the registry; the generated
README explains that path.

Set `TEST_DATABASE_URL` to the administrator database of a **dedicated test
PostgreSQL server** with permission to create and drop databases. Alternatively,
pass `--database-url <url>` explicitly. No default server is selected by the CLI.
Every execution creates and cleans up a separate generated database.

## Discover, replay, and reduce

```sh
interleave run scenario.mjs --max-runs 50 --out failure.interleave.json
interleave replay scenario.mjs failure.interleave.json
interleave minimize scenario.mjs failure.interleave.json --out reduced.interleave.json
```

`run` explores observed actor-choice prefixes. Every attempt runs in a supervised
worker. It stops at the first invariant violation by default; `--keep-going`
continues within the selected limits. `--plan alice,bob,alice,bob` supplies the
initial actor-choice prefix. Sampled success does not prove race freedom.

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
interleave report failure.interleave.json --out failure.html
interleave export scenario.mjs failure.interleave.json --project-root . --out regression
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
interleave doctor
interleave demo neveroversell --out neveroversell.interleave.json
interleave demo neveroversell --safe
```

`doctor` creates its own disposable database, performs two real parameterized
queries through actor proxies, verifies the observations, and cleans up. It
reports the observed PostgreSQL and Node versions. This check does not certify
all PostgreSQL features or application drivers.

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
