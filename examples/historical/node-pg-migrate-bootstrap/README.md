# node-pg-migrate migrations-table bootstrap

Upstream: issue [salsita/node-pg-migrate#821](https://github.com/salsita/node-pg-migrate/issues/821),
"Migrations table is created outside lock", fixed by
[#830](https://github.com/salsita/node-pg-migrate/pull/830), "Put migrations table
check inside lock", merged 20 September 2021.

The runner takes a PostgreSQL advisory lock so that only one process applies
migrations. In 5.10.0 it first checks for the migrations table and creates it
when absent, and only then takes the lock. The issue reports that "for the first
run, multiple nodes running migrations will race to the table and conflict with
each other." The fix takes the lock before the table check. A runner that cannot
take the lock stops with "Another migration is already running".

| Directory | node-pg-migrate | Published | Relation to the fix |
| --- | --- | --- | --- |
| `before-fix/` | 5.10.0 | 29 June 2021 | `dist/runner.js` matches a build of the fix's parent commit [`8f173e6`](https://github.com/salsita/node-pg-migrate/commit/8f173e6660cedc5f1b990c93898713ad3e4b4911) except for the TypeScript compiler's call syntax |
| `after-fix/` | 6.0.0 | 20 September 2021 | `dist/runner.js` is byte-identical to a build of the merge commit [`1cd2ee9`](https://github.com/salsita/node-pg-migrate/commit/1cd2ee99c70b344c2f23928410f7da11b692f1e3) |

In the compiled runner, the only behavioral change between the two releases is
the moved lock call. Other compiled files differ in the TypeScript compiler's
call syntax. The 6.0.0 package also requires Node.js 12.13 or newer, upgrades
yargs and documents the runner option types; the options used here are the
same. Both directories use node-postgres 8.23.0.

## Scenario

`scenario.mjs` is identical in both directories.

- **Setup** leaves the new database empty: no migrations table exists.
- **Actors** `first` and `second` each connect their own `pg.Client` to their
  Interleave URL and pass it to the public runner with an empty `migrations/`
  directory, direction `up` and a silent logger, as two application instances
  would at startup. Each actor returns `completed`, the documented `busy`
  outcome, or the kind of failure it received.
- **Invariant**: at least one runner completes, every runner either completes or
  reports `busy`, the `pgmigrations` table exists and it records no migrations.

The runner wraps database errors in a new `Error` whose message quotes the
original, so the scenario classifies the text. A second `CREATE TABLE` that
starts after the first has committed fails with `42P07` ("already exists").
One that overlaps the first waits for it and then fails with a unique violation
on a system catalog index. Both are the same duplicate creation.

## Run it

From a built Interleave checkout, with `TEST_DATABASE_URL` set to a dedicated
administrator database (or `--docker` added to each execution command). The
empty `migrations` directory is read as data, so declare it when recording:

```sh
mkdir -p ../interleave-historical
cp -R examples/historical/node-pg-migrate-bootstrap ../interleave-historical/
case=../interleave-historical/node-pg-migrate-bootstrap
npm ci --prefix $case/before-fix
npm ci --prefix $case/after-fix

node dist/cli.js run $case/before-fix/scenario.mjs --include migrations \
  --timeout-ms 30000 --out npm-bootstrap.interleave.json
node dist/cli.js replay $case/before-fix/scenario.mjs npm-bootstrap.interleave.json --timeout-ms 30000
node dist/cli.js minimize $case/before-fix/scenario.mjs npm-bootstrap.interleave.json \
  --timeout-ms 30000 --out npm-bootstrap-reduced.interleave.json

node dist/cli.js replay $case/after-fix/scenario.mjs npm-bootstrap.interleave.json --guided --timeout-ms 30000
node dist/cli.js run $case/after-fix/scenario.mjs --include migrations --keep-going \
  --max-runs 100 --total-timeout-ms 900000 --timeout-ms 30000
```

Expected: the first run finds a violation (exit 1): both runners see no table,
the first creates it and the second's `CREATE TABLE` fails with `42P07`. Exact
replay repeats it, and minimization reaches zero explicit choices.

The guided run against 6.0.0 is `incompatible` (exit 3), not a pass. In the old
order the second runner issues its next command at step 3, but with the fix it
has already stopped at the lock. The actor results in that record reflect the
interrupted run. Use the bounded exploration of 6.0.0 to check the changed
behavior. In the measured exploration, 13 of its 15 schedules had one runner
complete and the other report `busy`; in the other 2, one runner finished and
disconnected before the other took the lock, so both completed.

To keep a portable regression of the 5.10.0 failure, use the separate
installation profile described in the
[historical cases guide](../README.md#keep-a-portable-regression). The offline
shared bundle currently fails for this case, because node-pg-migrate depends on
`@types/pg`.

## Baselines

```sh
node examples/historical/harness/baseline.mjs --scenario $case/before-fix/scenario.mjs \
  --mode ordinary --trials 100
node examples/historical/harness/baseline.mjs --scenario $case/before-fix/scenario.mjs \
  --mode barrier --barrier $case/barrier.mjs --trials 20
```

The barrier withholds each runner's table-check result until both runners have
checked, or until one has finished without reaching the check, which is what
happens with 6.0.0. The isolation specs in [`isolation/`](isolation/) transcribe
the table check, creation, lock and journal read. The tester keeps its sessions
connected, so the serial permutations call `pg_advisory_unlock_all()` where the
first runner's client would disconnect and release its session lock.
