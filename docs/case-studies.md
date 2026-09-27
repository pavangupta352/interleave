# Historical case studies

Measured on 27 September 2026. This page records how Interleave and three other
methods handled three concurrency defects that were reported and fixed in
open-source Node.js PostgreSQL libraries. Each case runs the library's unchanged
public API from the npm release published before the fix and from the first
release that contains it. The runnable cases are in
[`examples/historical`](../examples/historical/README.md).

These are measurements of three scenarios on one machine. They are not detection
rates for other applications, a benchmark, or evidence that any method finds
every race.

## Summary

| Case | Defect before the fix | Upstream fix | Releases |
| --- | --- | --- | --- |
| [Knex migration lock](#knex-migration-lock) | Two processes can both see an empty lock table and insert two lock rows | [knex/knex#4694](https://github.com/knex/knex/pull/4694) | 0.95.11 → 0.95.12 |
| [node-pg-migrate bootstrap](#node-pg-migrate-bootstrap) | Two runners can both find no migrations table; the second `CREATE TABLE` fails | [salsita/node-pg-migrate#830](https://github.com/salsita/node-pg-migrate/pull/830) | 5.10.0 → 6.0.0 |
| [Sequelize findCreateFind](#sequelize-findcreatefind) | In a PostgreSQL transaction, the losing insert aborts the transaction and the retry lookup fails | [sequelize/sequelize#13482](https://github.com/sequelize/sequelize/pull/13482) | 6.7.0 → 6.8.0 |

Results on PostgreSQL 16.15:

| Measurement | Knex | node-pg-migrate | Sequelize |
| --- | --- | --- | --- |
| Interleave: runs until the first violation, before the fix | 1 | 1 | 1 |
| Exact replays with the same failure | 20 of 20 | 20 of 20 | 20 of 20 |
| Reduction of explicit choices | 12 → 0, 5 attempts | 6 → 0, 4 attempts | 15 → 0, 5 attempts |
| Portable export, install and replay | Shared offline bundle: 3 of 3 replays reproduced the failure | Shared offline bundle rejected by an Interleave [defect](#findings-about-interleave); separate-installation bundle: 3 of 3 | Same as node-pg-migrate: rejected; separate: 3 of 3 |
| Old order replayed against the fixed release (guided) | Passed | Incompatible: the old order no longer fits | Passed |
| Explored schedules with a violation, before / after the fix | 61 of 100 / 0 of 100 | 25 of 67 / 0 of 15 (both frontiers exhausted) | 84 of 100 / 0 of 100 |
| Ordinary concurrency, violations in 100 trials, before / after | 91 / **84** | 100 / 0 | 96 / 0 |
| Manual barrier, violations in 20 trials, before / after | 20 / **20** | 20 / 0 | 20 / 0 |
| Isolation tester, race permutation, before / after | 2 lock rows / 1 row | "already exists" error / lock refused | unique violation, then aborted-transaction error / row found |

What these results show:

- Every method reproduced all three original defects. Ordinary concurrency did
  so in 91 to 100 of 100 trials on this machine, so these races were not rare
  here. The methods differed in repeatability, the evidence they left, and the
  knowledge they required.
- Interleave found each defect on its first run without being told where the
  race was, replayed each failure exactly, and reduced each to zero explicit
  choices. In the Sequelize case its record includes the lock wait that
  PostgreSQL reported for the losing insert. Its offline export bundle worked
  for Knex. For the other two cases it rejected the applications' dependency
  archives, which is a defect in the current development build; the separate
  installation profile, which installs dependencies with ordinary `npm ci`,
  exported and replayed both.
- node-pg-migrate 6.0.0 and Sequelize 6.8.0 passed under every method.
- **Knex 0.95.12 is the important miss.** Its fix passed Interleave's guided
  replay, 100 explored schedules and the isolation tester, yet ordinary
  concurrency still produced two lock rows in 84 of 100 trials and the manual
  barrier in 20 of 20. The fixed insert is not atomic when two copies run at the
  same time, and neither Interleave's scenario nor the isolation spec ran them at
  the same time. A deliberately added blocker session made the overlap
  repeatable under both.
- Knex changed this code again two months later. With the unchanged scenario, which starts with both tables present and the lock
  row missing,
  Knex 3.3.0, the latest release at the time of measurement, produced two lock
  rows on Interleave's first run, in 20 of 20 exact replays, in 93 of 100
  ordinary trials and in 20 of 20 barrier trials.

## Conditions

| Item | Value |
| --- | --- |
| Machine | Apple M4, 10 cores, 16 GiB memory, macOS 27.0 |
| Load | A shared development machine; other projects' builds and tests ran throughout. Sampled every 5 seconds after the first nine minutes of measurement, the one-minute load average ranged from 3.5 to 12.3 (median 7.2). |
| PostgreSQL | 16.15 (`postgres:16` image `sha256:f1c3376c26f2…`), one owned container, default configuration |
| Node.js / npm | 24.7.0 / 11.5.1 |
| Driver | node-postgres 8.23.0 in every application |
| Interleave | 0.1.0-dev.0 development archive built from source `3785d49` (SHA-256 `ea06841e…c561e5`), installed into each application with `npm install --save-exact` |
| Isolation tester | Built from the PostgreSQL 16.15 source release inside a `postgres:16` Docker build stage |
| Dependencies | Committed lockfiles resolved in September 2026; the 2021 library releases run on current transitive dependencies |
| Execution limits | 30-second limit per Interleave run; baseline trials had a 30-second deadline and none reached it |

A smaller subset also ran on PostgreSQL 17.11 and 18.6; see
[other PostgreSQL versions](#other-postgresql-versions).

Every execution used a new generated database, and every baseline trial checked
afterwards that its database was gone.

## Methods

### The scenario

Each case has one `scenario.mjs`, identical before and after the fix. It creates
the starting state, defines two actors that call the library's public API, and
asserts the failure that the upstream report describes:

- Knex: both actors call `knex.migrate.list()`; exactly one unlocked lock row
  must remain.
- node-pg-migrate: both actors run the programmatic runner with an empty
  migrations directory; each must complete or report the documented "Another
  migration is already running".
- Sequelize: both actors call `Model.findCreateFind` inside their own managed
  transaction; both must return the same claim and exactly one row must exist.

Each actor builds the library's own client from the connection string it is
given and closes it when finished. Actors return what the application observed,
such as a busy result or an error code, so that the invariant can judge it;
Interleave treats a rejected operation as an actor error rather than a
violation.

The other application-level baselines import this same file and use its setup,
actors and invariant, so every method checks the same workload and rule.

### Interleave

The scenario ran through the installed CLI: `run` without a plan to discover a
failure, `replay` 20 times, `minimize`, `report`, and `export` followed by the
generated offline installer and replay in a new directory whose path contains
spaces. The fixed release was checked three ways: exact replay of the failing
record (expected to be incompatible, because the source changed), guided replay
of its actor order, and a fresh bounded exploration. Explorations used
`--keep-going --max-runs 100` and the default FIFO order.

Interleave releases one protocol command at a time and waits for it to
complete. It lets another actor proceed while a command is still running only
when PostgreSQL reports that command waiting for a lock held by another actor.

### Ordinary concurrency

[`harness/baseline.mjs`](../examples/historical/harness/baseline.mjs) with
`--mode ordinary` creates a database, runs the scenario's setup, starts both
actors in the same event-loop turn with the direct database URL, evaluates the
invariant and drops the database. Nothing coordinates the actors. 100 trials
per release.

### Manual barrier

`--mode barrier` adds [`harness/result-barrier.mjs`](../examples/historical/harness/result-barrier.mjs)
around node-postgres's `Client.prototype.query`. The case's `barrier.mjs` names
one statement. The first time each client sends it, PostgreSQL runs it
normally, but the result is withheld until every actor has reached that point or
finished, and then all withheld results are delivered together. SQL, parameters
and library code are unchanged. Writing it requires knowing which statement
boundary matters. 20 trials per release.

### PostgreSQL isolation tester

Each case has specs that transcribe the SQL the library sent, taken from
Interleave's recorded commands, into isolation-tester sessions and steps. Bound
values are written as literals. The tester runs SQL only: it cannot run the
library's JavaScript, so the author writes each branch as a separate
permutation. For example, a session whose lookup finds a row simply has no
insert step. The tester, like Interleave, starts the next step only after the
previous one completes or is detected waiting for a lock. Each spec ran five
times; all five outputs were identical for every spec.

### Setup effort

Non-blank lines that are not line comments, counted in the committed files:

| Artifact | Knex | node-pg-migrate | Sequelize |
| --- | ---: | ---: | ---: |
| Scenario, used by Interleave and both application baselines | 41 | 57 | 47 |
| Barrier statement matcher | 4 | 4 | 4 |
| Isolation specs, before and after the fix | 42 | 46 | 47 |

Shared across the cases: the baseline harness (127 lines), the result barrier
(64 lines), the tester Dockerfile (23 lines) and the spec runner (55 lines).
Building the tester image took 38 seconds here with the base image already
present.

The effort differs in kind as well as size. The Interleave commands need no
knowledge of where the race is. The barrier needs the exact statement text to
hold. The isolation specs need every statement transcribed, bound values
inlined, and each application branch written out by hand.

## Knex migration lock

Knex's `ensureTable` reads `knex_migrations_lock` and inserts a row when the
read returns none. In 0.95.11 the read and the insert are separate statements,
so two processes can both read an empty table and both insert. The pull request
calls two lock rows "a non-recoverable state where no lock can later be
acquired". 0.95.12 replaced the insert with `INSERT ... SELECT ... WHERE NOT
EXISTS`. Its `table-creator.js` is byte-identical to the fix's merge commit, and
0.95.11's to the commit before it. The release contains other changes, but the
recorded SQL of the two releases differs only in that insert.

Setup calls `knex.migrate.list()` once to create both tables, then deletes the
lock row. This is the state after the tables exist and before the first lock
row. It does not reproduce a simultaneous fresh-schema bootstrap, where the
`CREATE TABLE` statements could collide first.

### Interleave

The first run used Interleave's fair rotation: each actor sent its version
query, two table checks and the lock-row read before either insert, and both
inserts succeeded. The invariant failed with two lock rows. All 20 exact
replays repeated the same 12 commands and failure, with a median wall time of
3.3 seconds per replay command (2.3 to 3.9 seconds). Reduction removed all 12
explicit choices in 5 attempts (13.8 seconds); five exact replays of the reduced
record failed the same way. Serial orders, all of one actor's commands before
the other's, passed in both directions.

Export produced a shared-installation bundle with 42 files and 37 package
archives. Its verification passed, the generated installer completed offline in
10.7 seconds, and three replays from the installed bundle reproduced the
original failure.

Against 0.95.12, exact replay of the old record stopped as `incompatible`
before any SQL ran, because the installed source had changed. Guided replay of
the same 12-choice order passed: the second conditional insert changed no row.
Exploring 100 schedules of 0.95.12 found no violation (164 prefixes remained);
the same 100 schedules found 61 violations with 0.95.11.

### Baselines

Ordinary concurrency produced two lock rows in 91 of 100 trials with 0.95.11.
The manual barrier, holding each actor's lock-row read until both had read,
produced them in 20 of 20. The isolation spec's race permutation ended with two
rows and its serial permutations with one.

With 0.95.12, the isolation spec's race permutation ended with one row, like
Interleave. **Ordinary concurrency still produced two rows in 84 of 100 trials,
and the barrier in 20 of 20.**

### What the fix left open

Two `INSERT ... WHERE NOT EXISTS` statements that run at the same time can both
see an empty table before either inserts. Ordinary concurrency starts both
actors together, and their identical command sequences stay close enough that
the two inserts often overlap. The barrier delivers both read results at once,
so both inserts start together. Interleave and the isolation tester start a
command only after the previous one has completed, unless PostgreSQL reports a
lock wait, so with the application's statements alone they never overlapped the
inserts. They each reported a passing result for code that still fails.

To confirm the mechanism, both were given a blocker that is test scaffolding
rather than Knex code: a session that runs `ALTER SEQUENCE` on the lock table's
sequence inside a transaction. Each conditional insert then waits at `nextval()`
after its `NOT EXISTS` check has seen an empty table. With the blocker, the
isolation spec produced two rows in 5 of 5 runs. Interleave's
[`overlap-scenario.mjs`](../examples/historical/knex-migration-lock/after-fix/overlap-scenario.mjs)
recorded both inserts waiting on the blocker's lock and then two rows when run
with an explicit plan that holds the blocker's `COMMIT` until both inserts have
started. All 10 exact replays repeated the failure with both waits. Reduction
kept 10 of the 15 explicit choices (31 attempts, 41.9 seconds): the blocker's
first two commands must still precede the inserts. Without that plan the
blocker committed early and the run passed, and an unseeded exploration of 60
schedules found no violation. Knowing where to hold the lock was the test
author's contribution, as it is for the barrier.

Knex changed this insert again in [knex/knex#4865](https://github.com/knex/knex/pull/4865),
released in 0.95.15, because the `SELECT` without `FROM` failed on Oracle and
MariaDB. That version reads the lock table a second time and inserts only if
the second read is empty. Knex 3.3.0, the latest release at the time of
measurement, has the same code, and the unchanged scenario fails with it:

| Knex 3.3.0 | Result |
| --- | --- |
| Interleave, first run | Violation: each actor sent seven commands, and the fair rotation ran both second reads before either insert |
| Exact replays | 20 of 20 with the same failure |
| Reduction | 14 → 0 explicit choices in 5 attempts |
| Ordinary concurrency | 93 of 100 trials with two lock rows |
| Manual barrier | 20 of 20 |
| Isolation spec with the second read | Race permutation: 2 rows; a permutation where the second read follows the first insert: 1 row |

This describes the scenario's precondition, tables present and lock row
missing, on a current release. Whether deployments reach that state
concurrently was not studied, and nothing has been reported upstream.

## node-pg-migrate bootstrap

The runner takes an advisory lock so that only one process applies migrations.
In 5.10.0 it checks for and creates its `pgmigrations` table before taking that
lock; issue #821 reported that on the first run, "multiple nodes running
migrations will race to the table". 6.0.0 takes the lock first. Its compiled
runner is byte-identical to a build of the fix's merge commit. Apart from the
moved call, 5.10.0's runner differs only in the TypeScript compiler's call
syntax.

### Interleave

The first run released both table checks before either `CREATE TABLE`. The
first runner created the table; the second's `CREATE TABLE` failed with
`42P07`, and the invariant failed. All 20 exact replays repeated the 6-command
failure (median 1.2 seconds per replay command). Reduction removed all 6
choices in 4 attempts (4.1 seconds), and five replays of the reduced record
failed the same way. Both serial orders passed with both runners completing.
The exploration of 5.10.0 exhausted its frontier after 67 schedules, 25 of
which failed.

Against 6.0.0, the fair run and five exact replays of it passed: one runner took
the lock and completed, and the other reported `busy`. The exploration exhausted
its frontier after 15 schedules with no violation: 13 ended with one runner
busy, and in 2 the first runner finished before the second took the lock, so
both completed. Guided replay of the failing
order was `incompatible`, not passed: that order asks the second runner for a
command at step 3, but the fixed runner has already stopped at the lock. The
actor results in that record come from the interrupted run.

Export was rejected before writing a bundle: "Runtime archive contains an unsafe
or duplicate package path". The application's lock includes `@types/pg` and
`@types/node`, which node-pg-migrate lists as dependencies; their registry
archives use `pg/` and `node/` as the top-level directory instead of `package/`.

The separate installation profile does not repackage dependency archives. With
the same Interleave archive installed in its own directory outside the
application, a new recording of the 5.10.0 failure exported and verified. The
bundle installs the application and the runtime with two ordinary `npm ci`
commands, so the npm registry or a populated npm cache must be available; it is
not an offline bundle. Three replays from the installed bundle reproduced the
original failure.

### Baselines

Ordinary concurrency failed in 100 of 100 trials with 5.10.0 and passed in all
100 with 6.0.0. The barrier gave the same split in 20 trials each. With 6.0.0,
the barrier released the first runner as soon as the second had stopped at the
lock.

The failure looked different outside Interleave. When the two `CREATE TABLE`
statements overlap, the second waits for the first and then fails with a unique
violation on a system catalog index (`pg_class_relname_nsp_index` or
`pg_type_typname_nsp_index`), not `42P07`. Every ordinary and barrier failure
was of that kind. Interleave, which runs them one after the other, always
recorded `42P07`. Both are the same duplicate creation, and the invariant
treats them alike.

The isolation spec's race permutation ended with `ERROR: relation
"pgmigrations" already exists`; with 6.0.0 the second session's
`pg_try_advisory_lock` returned false. Tester sessions stay connected, so the
serial permutations call `pg_advisory_unlock_all()` where the application's
first client would disconnect.

## Sequelize findCreateFind

`findCreateFind` looks a row up, creates it if absent, and on a unique
violation looks it up again. Inside a PostgreSQL transaction the unique
violation aborts the transaction, so the second lookup fails with `25P02`.
6.8.0 inserts with `ON CONFLICT DO NOTHING` when a transaction is supplied and
treats an insert that returns no row as a signal to look the row up again. Its
`lib/model.js` is byte-identical to the fix's squash commit. The recorded SQL of
the two releases differs only in that clause.

### Interleave

The first run used the fair rotation. Both transactions looked the claim up and
found nothing; alice inserted; bob's insert then waited, and Interleave
recorded the wait from PostgreSQL's lock data with alice's backend as the
blocker. Interleave released alice's `COMMIT`, bob's insert failed with
`23505`, the retry lookup failed with `25P02`, and bob's transaction rolled
back. All 20 exact replays
repeated the same 15 commands, the same wait and the same failure (median 1.7
seconds per replay command). Reduction removed all 15 choices in 5 attempts
(16.0 seconds). Both serial orders passed with one call creating the claim and
the other finding it.

Against 6.8.0, guided replay of the same order passed: bob's insert waited,
inserted nothing, and the retry lookup found alice's row. The fair run and five
exact replays of it passed as well. Exploring 100 schedules found no violation
with 6.8.0; the same 100 schedules found 84 violations with 6.7.0, and 54 of
them included a recorded lock wait in both releases.

Export was rejected with the same message as node-pg-migrate. Sequelize 6.7.0
depends on `wkx`, which depends on `@types/node`. A separate-installation
recording exported, verified, installed with `npm ci` and replayed the original
failure 3 of 3 times, as for node-pg-migrate.

### Baselines

Ordinary concurrency failed in 96 of 100 trials with 6.7.0 and passed in all
100 with 6.8.0. The barrier failed in 20 of 20 with 6.7.0 and passed in 20 of 20
with 6.8.0. The isolation spec's race permutation showed bob's insert waiting,
then `duplicate key value violates unique constraint "claims_claim_key_key"`,
then `current transaction is aborted` for the retry lookup; with 6.8.0 the insert
waited, returned no row, and the retry lookup returned alice's row.

## Other PostgreSQL versions

On PostgreSQL 17.11 and 18.6 (official `postgres:17` and `postgres:18` images,
one owned container each, removed afterwards), each case ran Interleave's first
run, five exact replays, a guided replay against the fixed release, one run of
the fixed release, and 100 ordinary trials per release. The barrier, the
isolation tester, reduction, export and the 100-schedule explorations ran only
on 16.15.

| Measurement | Knex | node-pg-migrate | Sequelize |
| --- | --- | --- | --- |
| First run before the fix, 17.11 / 18.6 | Violation / violation | Violation / violation | Violation / violation |
| Exact replays with the same failure, 17.11 / 18.6 | 5 of 5 / 5 of 5 | 5 of 5 / 5 of 5 | 5 of 5 / 5 of 5 |
| Guided replay against the fixed release | Passed on both | Incompatible on both | Passed on both |
| One run of the fixed release | Passed on both | Passed on both | Passed on both |
| Ordinary concurrency before / after, 17.11 | 87 / 73 | 92 / 0 | 88 / 0 |
| Ordinary concurrency before / after, 18.6 | 87 / 79 | 89 / 0 | 76 / 0 |

The pattern matches 16.15, including ordinary concurrency's failures with the
fixed Knex release.

## Findings about Interleave

These came from the study. The study itself did not change Interleave; the
development version after it addresses the first three as noted below. The
measurements above are unchanged and describe the archive that was measured.

- **Portable export rejects `@types` archives.** The shared-installation export
  requires every package archive's entries to start with `package/`. npm accepts
  any single top-level directory, and DefinitelyTyped packages such as
  `@types/node` and `@types/pg` use their own names. Any application whose lock
  contains one cannot be exported in that profile, and the error names neither
  the package nor the lock entry. This blocked the offline regression for
  node-pg-migrate and Sequelize; the separate installation profile, which
  needs npm access to install, worked for both.
  *Addressed after this study:* shared exports now strip whichever single
  top-level directory a package archive uses, as npm does, and still reject
  archives with more than one. The two shared exports have not been re-measured.
- **A scenario that fails to load gives little guidance.** The first Sequelize
  scenario used a named ESM import from the CommonJS package, which Node.js
  rejects. `interleave run` reported "1 attempted, 0 completed; violations: 0;
  inconclusive" and exited 2. The retained run's outcome, `harness-error`, and
  its reason, "Scenario loading or worker execution failed", appear only in
  `--json` output. Interleave withholds the exception text on purpose, because it
  may contain credentials; the human summary could still name the outcome and
  suggest importing the scenario directly with Node.js to see the error.
  *Addressed after this study:* the human summary now names the first run that
  could not be evaluated, with its outcome and recorded reason.
- **Exporting from a checkout packs everything under `examples/`.** A
  recording made with a checkout's CLI exports by packing that checkout. While
  installed `node_modules` directories existed under `examples/historical`,
  export stopped with "Command output exceeds 1 MiB: npm" and left an
  incomplete folder; after removing them, the same export succeeded. The
  package's `files` list includes `examples`, so a local `npm pack` of such a
  checkout would also include those dependencies.
  *Addressed after this study:* `examples/.npmignore` now excludes installed
  `node_modules` directories from the package.
- **Statement overlap is outside the scheduling model.** This is documented
  behavior, not a defect, but the Knex case shows its cost: a fix that is only
  correct when statements do not overlap passes every Interleave schedule of
  the application's own commands.

## Harness and scenario problems during the study

- The first Sequelize scenario did not load, as described above. It was
  corrected before any measured run.
- The first node-pg-migrate scenario classified the catalog unique violation
  from overlapping `CREATE TABLE` statements as `unexpected-error`. The outcome
  was already a violation; the classification was corrected before the measured
  runs so that ordinary and barrier failures are named accurately.
- In the incompatible guided replay against node-pg-migrate 6.0.0, the first
  runner's observation is `unexpected-error` because Interleave stopped the run
  and closed its connection. The record is incompatible, and its actor values
  are not results of a completed run.
- No baseline trial timed out, rejected in the harness, or failed its database
  cleanup check. No Interleave run ended `inconclusive` or `harness-error`
  after the scenarios were corrected.

## Not established

- **No participant study.** Nobody outside the project has tried these steps;
  setup effort above is line counts, not observed effort.
- **One machine and a shared load.** Ordinary concurrency rates depend on
  timing and would differ elsewhere. Durations include process start-up,
  database creation and source hashing and are not performance comparisons.
- **One runtime.** Everything ran on Node.js 24.7.0; Node.js 22 was not run
  for these cases. PostgreSQL 17.11 and 18.6 ran only the subset listed above.
- **Published releases, current dependencies.** The fixed releases contain
  other changes besides each fix, and all transitive dependencies are 2026
  resolutions. Earlier private checks against the exact fix commits used a
  different Interleave build and are not part of these results.
- **Bounded exploration.** 100 explored schedules, or an exhausted frontier
  under Interleave's model, does not show that a release is race-free, as the
  Knex case demonstrates.
- **Precondition.** The Knex scenario starts with the tables created and the
  lock row missing, rather than two processes bootstrapping an empty database.
- **No upstream reports** were filed for the Knex results.

## Reproducing

The cases, harnesses, specs and tester outputs are in
[`examples/historical`](../examples/historical/README.md), with commands in
each case README. The raw run records, logs and exported bundles from this
measurement are kept outside the repository by the maintainer.
