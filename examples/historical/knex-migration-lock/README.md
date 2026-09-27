# Knex migration lock initialization

Upstream: [knex/knex#4694](https://github.com/knex/knex/pull/4694), "Avoid
inserting multiple locks if a lock already exists", merged 29 September 2021.

Before Knex lists or runs migrations, `ensureTable` in
`lib/migrations/migrate/table-creator.js` makes sure the migration tables exist
and that `knex_migrations_lock` holds a row. In Knex 0.95.11 it reads the lock
table and, when the read returns no rows, inserts one. Two processes can both
read the empty table before either inserts, which leaves two lock rows. The pull
request describes the consequence: "Multiple locks in the lock table is a
non-recoverable state where no lock can later be acquired." The fix replaced the
insert with a single `INSERT ... SELECT ... WHERE NOT EXISTS`.

| Directory | Knex | Published | Relation to the fix |
| --- | --- | --- | --- |
| `before-fix/` | 0.95.11 | 3 September 2021 | `table-creator.js` is byte-identical to the fix's parent commit [`c778c82`](https://github.com/knex/knex/commit/c778c82f2fd39944e081effa7ce945438cb62ba8) |
| `after-fix/` | 0.95.12 | 27 October 2021 | `table-creator.js` is byte-identical to the merge commit [`a54857e`](https://github.com/knex/knex/commit/a54857ec3c5fe7a67a7253bd2aa16f735a149abe) |
| `later-release/` | 3.3.0 | 26 June 2026 | Uses the lock-row insert from the later [knex/knex#4865](https://github.com/knex/knex/pull/4865), first released in 0.95.15 |

0.95.12 is a normal release and contains other changes besides the fix,
including files on this path such as the PostgreSQL dialect and query compiler.
The SQL recorded for the two releases is identical except for the lock-row
insert. All three directories use node-postgres 8.23.0.

## Scenario

`scenario.mjs` is identical in every directory.

- **Setup** calls the public `knex.migrate.list()` once to create both migration
  tables, then deletes the lock row. This is the state after the tables exist and
  before the first lock row is inserted. It is not a simultaneous fresh-schema
  bootstrap, where the two `CREATE TABLE` calls could race first.
- **Actors** `alice` and `bob` each create their own Knex instance on their
  Interleave URL, with a pool of one connection, and call `knex.migrate.list()`
  with an empty custom migration source. Knex selects its driver dynamically, so
  the scenario imports `pg` to declare it as a source input.
- **Invariant**: exactly one unlocked lock row and no recorded migrations.

Knex sends six commands per actor: its version query, two table checks, the
lock-row read, the insert and the completed-migration read.

## Run it

From a built Interleave checkout, with `TEST_DATABASE_URL` set to a dedicated
administrator database (or `--docker` added to each execution command):

```sh
mkdir -p ../interleave-historical
cp -R examples/historical/knex-migration-lock ../interleave-historical/
case=../interleave-historical/knex-migration-lock
npm ci --prefix $case/before-fix
npm ci --prefix $case/after-fix

node dist/cli.js run $case/before-fix/scenario.mjs --timeout-ms 30000 --out knex.interleave.json
node dist/cli.js replay $case/before-fix/scenario.mjs knex.interleave.json --timeout-ms 30000
node dist/cli.js minimize $case/before-fix/scenario.mjs knex.interleave.json \
  --timeout-ms 30000 --out knex-reduced.interleave.json

node dist/cli.js replay $case/after-fix/scenario.mjs knex.interleave.json --guided --timeout-ms 30000
node dist/cli.js run $case/after-fix/scenario.mjs --keep-going --max-runs 100 \
  --total-timeout-ms 900000 --timeout-ms 30000
```

Expected: the first run finds a violation (exit 1) with two lock rows, and exact
replay repeats it. Minimization reaches zero explicit choices: Interleave's
default fair rotation already produces the failing order. The guided run of
the same order against 0.95.12 passes, and the bounded exploration of 0.95.12
finds no violation. Those passing results are not the whole story; see below.

This case also exports as an offline shared bundle when Interleave is installed
into the copied application; see the
[historical cases guide](../README.md#keep-a-portable-regression).

## What the fix left open

`INSERT ... SELECT ... WHERE NOT EXISTS` checks and inserts in one statement,
but two such statements that run at the same time can both see an empty table
before either inserts. Interleave releases one command and waits for it to
complete unless PostgreSQL reports that it is waiting for a lock, so the
application scenario above never runs the two inserts at the same time. The
isolation tester has the same limit. Ordinary concurrency and the manual
barrier do run them at the same time, and both still produced two lock rows
with 0.95.12.

[`after-fix/overlap-scenario.mjs`](after-fix/overlap-scenario.mjs) makes that
overlap repeatable. It adds a third actor that is test scaffolding, not Knex
code: inside a transaction it runs `ALTER SEQUENCE` on the lock table's sequence,
so each conditional insert waits at `nextval()` after its `NOT EXISTS` check.
Release both inserts while the blocker holds the lock:

```sh
node dist/cli.js run $case/after-fix/overlap-scenario.mjs --max-runs 1 --timeout-ms 30000 \
  --plan alice,bob,alice,bob,alice,bob,alice,bob,blocker,blocker,alice,bob,blocker \
  --out knex-overlap.interleave.json
```

Both inserts are recorded as real lock waits on the blocker, and the invariant
fails with two rows. Without the plan, Interleave's fair rotation lets the
blocker commit before the inserts and the run passes; knowing where to hold the
lock is the test author's contribution here, as it is for the barrier.
[`isolation/after-fix-overlap.spec`](isolation/after-fix-overlap.spec) does the
same with a blocker session.

## A later release

Knex replaced this insert in [knex/knex#4865](https://github.com/knex/knex/pull/4865)
(first released in 0.95.15) because its `SELECT` without `FROM` failed on
Oracle and MariaDB. The replacement reads the lock table a second time and
inserts only if that second read is empty, which is again a separate check and
insert. `later-release/` runs the unchanged scenario against Knex 3.3.0, the
latest release when this was measured:

```sh
npm ci --prefix $case/later-release
node dist/cli.js run $case/later-release/scenario.mjs --timeout-ms 30000 --out knex-3.3.0.interleave.json
```

The first run fails with two lock rows: each actor now sends seven commands, and
the fair rotation runs both second reads before either insert.
[`isolation/later-release.spec`](isolation/later-release.spec) transcribes the
second read. The [case study](../../../docs/case-studies.md#knex-migration-lock)
records the measurements for all three releases.

## Baselines

```sh
node examples/historical/harness/baseline.mjs --scenario $case/after-fix/scenario.mjs \
  --mode ordinary --trials 100
node examples/historical/harness/baseline.mjs --scenario $case/after-fix/scenario.mjs \
  --mode barrier --barrier $case/barrier.mjs --trials 20
```

The barrier withholds each actor's lock-row read result until both actors have
read the lock table. The isolation specs in [`isolation/`](isolation/) transcribe
the lock-row read and insert; see the [historical cases guide](../README.md#run-the-baselines)
for the tester image.
