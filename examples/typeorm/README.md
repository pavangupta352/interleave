# TypeORM example

This isolated example pins TypeORM **1.1.1** and node-postgres **8.23.0** and gives each actor its own PostgreSQL DataSource. It is separate from the Drizzle/Kysely examples and from the root development dependencies. TypeORM 1.1.1 declares Node `^20.19.0 || ^22.13.0 || >=24.11.0`, so it does not support Node 24.7.0. Both qualification jobs below run on Node 22.18.0 and fail explicitly on any other version. The [`typeorm-0.3`](../typeorm-0.3/README.md) variant pins TypeORM 0.3.31 with its own lock and reuses this helper and scenario unchanged.

## Use the actor helper

Use the actor's connection string and the supplied QueryRunner for application queries:

```js
import { withTypeOrmActor } from './connection.mjs';

async function actor(context) {
  return withTypeOrmActor(context, [], async runner => {
    return runner.query('SELECT $1::int AS value', [7]);
  });
}
```

Pass your EntitySchema objects or entity classes as the second argument and use `runner.manager` for entity operations. Await every query. Non-database work must observe `context.signal`; this helper cannot interrupt an arbitrary application promise.

The helper uses TypeORM's public PostgreSQL `driver` option to own its pg Pool before initialization returns. Each actor has a pool size of one, a five-second connection/acquisition timeout, and a single QueryRunner for its operation. Synchronization, migrations and extension installation are disabled. There is no global driver mutation or access to TypeORM's internal connection fields.

TypeORM's real startup queries are scheduled like any other command. With a connection URL, TypeORM 1.1.1 sends `SELECT version()` and then `SELECT * FROM current_schema()` before the operation runs, so an explicit plan must include two choices per actor for them.

When cancellation arrives after acquisition, the helper destroys leased clients through pg's public release callback. TypeORM can then unwind, release its runner and destroy its DataSource. Partial initialization and late acquisitions are also cleaned up, and real SQL/client errors reject the operation.

## Scenario module

`scenario.mjs` exports `createTypeOrmScenario(behavior)` and, as its default export, the unsafe `lost-update` scenario. Every behavior uses the helper, EntitySchema entities (`counter`, `entries`, `attempts`) and the QueryRunner's public transaction methods. Setup creates ordinary tables; the invariant checks the final rows.

| Behavior | Application code | Expected outcome |
| --- | --- | --- |
| `lost-update` | `findOneByOrFail`, then `update` with the read value plus one | Violation when both reads precede both writes |
| `atomic` | `runner.query('UPDATE … SET value = value + $1 … RETURNING value')` | Passes. TypeORM's QueryRunner returns `[rows, rowCount]` for an UPDATE |
| `crud-rollback` | Insert, read, update and read in a committed transaction; then a marker insert and a duplicate primary key in a second transaction, rolled back; then read, count and delete on the same connection | Passes with SQLSTATE 23505 caught and the marker absent |
| `serializable-retry` | A SERIALIZABLE transaction inserts an attempt marker, reads the counter and writes it plus one. On SQLSTATE 40001 it rolls back, checks that its marker is gone and restarts the whole transaction, up to three attempts | Passes. Each actor's committed marker names its final attempt |
| `serializable-error` | The same transaction without retry | The 40001 rejects the actor. Interleave reports `actor-error` and does not evaluate the invariant |

Only SQLSTATE 40001 is retried. Every attempt runs on the actor's single connection and takes a new snapshot, so the retried read observes the other actor's committed value.

## Functional qualification

`scripts/test-typeorm-functional.mjs` (`npm run test:typeorm-functional`) copies this example's `connection.mjs` and `scenario.mjs` into a new application directory, together with the `package.json` and `package-lock.json` of the example selected by `INTERLEAVE_TYPEORM_EXAMPLE`: `typeorm` (the default, TypeORM 1.1.1) or `typeorm-0.3` (TypeORM 0.3.31). It installs the supplied Interleave package archive there with the Node toolchain's own npm and then runs `test/typeorm/functional.mjs` inside that application. Every case runs the installed `interleave` CLI against real PostgreSQL. Generated entry modules wrap each behavior and append to journals when the scenario is imported, when setup creates a database, and when the invariant is called, returns or throws.

| Case | Command and required observations |
| --- | --- |
| Unsafe lost update | `run --plan` with four alternating choices per actor. The run records a violation (exit 1) with both actors reading 0 and writing 1. The first four steps are each actor's two startup queries; the entity-manager SELECT and UPDATE that follow are parameterized extended-protocol commands. `replay` reproduces the same failure, actor values, source and fixture identity, and step fingerprints |
| Atomic increment | The same alternation passes, with `written` values 1 and 2 |
| CRUD and 23505 rollback | Each actor's COMMIT ends in transaction state I. The duplicate insert fails with 23505 in state E, and ROLLBACK returns to I. The marker row is absent, and the SELECT, COUNT and DELETE that follow run on the same backend without error |
| Unhandled 40001 | With both snapshot reads before both UPDATEs, bob's UPDATE waits on a Lock held by alice's backend. It fails with 40001 in state E after alice's COMMIT. The outcome is `actor-error` (exit 2), the invariant journal has no entry for that run, and bob's ROLLBACK and marker check are his last commands |
| Whole-transaction retry | Same schedule and failure. After ROLLBACK and the marker check, bob runs START TRANSACTION, SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, INSERT, SELECT, UPDATE and COMMIT again without error; the new SELECT is released after alice's COMMIT. Bob returns `{ attempts: 2, reads: [0, 1], errors: ['40001'], rollbackVerified: true }`, and the invariant returns |
| Serial schedules | Both serializable behaviors pass with reads 0 then 1 and no errors |
| Minimization | Only with `INTERLEAVE_TYPEORM_PORTABLE=1`. `minimize` keeps the same failure fingerprint, reports `locally-minimal` and creates one database per attempt. Observed: 8 choices reduced to 0 in 5 attempts, because the fair fallback alone reproduces the lost update |
| Helper source drift | Only with `INTERLEAVE_TYPEORM_PORTABLE=1`. After a comment is appended to the copied `connection.mjs`, exact replay is `incompatible` (exit 3) with an empty trace, before any import, setup or invariant call. The original bytes are restored |
| Original-archive export | Only with `INTERLEAVE_TYPEORM_PORTABLE=1`. `export --runtime-archive` with the original archive the application was installed from, `verifyRegressionExport`, an identical app lock and `run.json`, `install.mjs --offline`, and then the exported exact replay. The replay must give the same failure, actors, source, fixture and fingerprints |
| Cleanup | Every generated database and its backends are absent from the server. Every command process has exited, and the application lock is unchanged |

A passing single sample is recorded with `run --max-runs 1`. The search then stops at its one-run budget and the CLI exits 4. The gate requires `stopReason: "max-runs"` together with a retained run whose outcome is `passed`. A sampled passing schedule is evidence about that schedule only.

Observed on 2026-09-27 with the Interleave 0.1.0-dev.0 archive built from commit 3785d49, on macOS arm64 with official Docker images:

| Node / npm | TypeORM / pg | PostgreSQL | Cases |
| --- | --- | --- | --- |
| 22.18.0 / 10.9.3 | 1.1.1 / 8.23.0 | 16.15 | 11/11, including minimization, drift and portable replay |
| 22.18.0 / 10.9.3 | 1.1.1 / 8.23.0 | 17.11 | 11/11, including minimization, drift and portable replay |
| 22.18.0 / 10.9.3 | 1.1.1 / 8.23.0 | 18.6 | 11/11, including minimization, drift and portable replay |
| 22.18.0 / 10.9.3 | 0.3.31 / 8.23.0 | 16.15 | 11/11, including minimization, drift and portable replay |
| 22.18.0 / 10.9.3 | 0.3.31 / 8.23.0 | 17.11 | 11/11, including minimization, drift and portable replay |
| 22.18.0 / 10.9.3 | 0.3.31 / 8.23.0 | 18.6 | 11/11, including minimization, drift and portable replay |

Each row recorded, replayed, minimized and exported against its own server. No artifact was replayed across PostgreSQL versions, and exact replay rejects a different server version.

Run the gate from the repository root with Node 22.18.0 selected. The example's own `node_modules` is not used: the gate installs the pinned lock into its new application, which needs npm registry access or a warm npm cache. Build and pack the runtime under test and use the archive name that `npm pack` prints, or supply an existing original archive:

```sh
npm ci --ignore-scripts
npm run build
mkdir -p ../interleave-runtime
npm pack --ignore-scripts --pack-destination ../interleave-runtime
TEST_DATABASE_URL='<dedicated PostgreSQL administrator URL>' \
INTERLEAVE_TYPEORM_RUNTIME_ARCHIVE=../interleave-runtime/pavangupta352-interleave-<version>.tgz \
INTERLEAVE_TYPEORM_EVIDENCE=../typeorm-functional-evidence \
INTERLEAVE_TYPEORM_PORTABLE=1 \
npm run test:typeorm-functional
```

`INTERLEAVE_TYPEORM_EVIDENCE` must name a directory that does not exist yet. The gate refuses to reuse one. Set `INTERLEAVE_TYPEORM_RUNTIME_SHA256` to require an exact archive hash. The evidence directory keeps `install.json` (Node, npm, archive hash and install output), numbered command records (`NN.json`, `NN.stdout`, `NN.stderr`), each run artifact, the journals (`imports.txt`, `owned.txt`, `invariants.jsonl`), `cleanup.json`, `results.json` and, for portable runs, the exported bundle. The generated entry modules journal only when their environment variables are set, so the exported bundle also replays without them.

## Lifecycle qualification

Run the separate lifecycle job from the repository root, with Node 22.18.0 selected and a dedicated PostgreSQL administrator database. It uses this checkout's own build of Interleave:

```sh
npm ci --ignore-scripts
npm run build
npm ci --prefix examples/typeorm --ignore-scripts
TEST_DATABASE_URL='<dedicated PostgreSQL administrator URL>' npm run test:typeorm
```

Use credentials for your dedicated test server. The job creates and removes its own generated application databases; it checks their absence independently. Neither job is silently included in or skipped by the root suite. The lifecycle job's source-bound check retains a copied exact-pin consumer under the system temporary directory, or under `INTERLEAVE_TYPEORM_RUN_DIRECTORY` when supplied. `INTERLEAVE_TYPEORM_JOURNAL` optionally records raw observations and run artifacts. `INTERLEAVE_TYPEORM_EXAMPLE=typeorm-0.3` runs the same checks against the 0.3.31 installation; see that variant's README.

Its checks cover normal rows, wire SQLSTATE 23505, real lock waits, cancellation/deadline actor settlement, queued initialization and queries, initial acquisition/timeout, queued QueryRunner acquisition, checked-out client failure, and in-process/supervised containment. Transactions, retry and export/replay for this helper are qualified by the functional gate above, not by the lifecycle job.

| Node | TypeORM / pg | PostgreSQL 16.15 | PostgreSQL 17.11 | PostgreSQL 18.6 |
| --- | --- | --- | --- | --- |
| 22.18.0 | 1.1.1 / 8.23.0 | 14/14 | 14/14 | 14/14 |
| 22.18.0 | 0.3.31 / 8.23.0 | 14/14 | 14/14 | 14/14 |

In every row, both blocked-query checks still found the server backend in a `Lock`/`transactionid` wait after the client closed. The pending-acquisition check settled at the real pg timeout, after about five seconds.

## Limits

- **Closing a client does not send PostgreSQL CancelRequest.** A server statement waiting for a lock can remain after the actor's promise and pool have closed. Interleave's owned-database cleanup supplies containment. Client settlement and server/database absence are separate checks.
- **Acquisition before a client is available can take up to the configured five-second pg timeout.** A connection that arrives after cancellation is destroyed before TypeORM uses it. This is not a promise of immediate in-process settlement during network startup.
- The retry example handles SQLSTATE 40001 only. Deadlocks (40P01), COMMIT-time serialization failures under other schedules and retry backoff were not exercised.
- Not qualified: other TypeORM APIs such as `save`, relations, cascades, `DataSource.transaction()`/`manager.transaction()`, pessimistic locks, migrations and synchronization; shared pools across actors; replicas; native drivers; other databases; Node 24; operating systems other than macOS arm64; and exact replay across PostgreSQL versions.

Public API references: [TypeORM QueryRunner](https://typeorm.io/docs/query-runner/), [TypeORM PostgreSQL options](https://typeorm.io/docs/drivers/postgres/), [pinned PostgreSQL driver option](https://github.com/typeorm/typeorm/blob/1.1.1/src/driver/postgres/PostgresDataSourceOptions.ts), and [pg Pool acquisition/release](https://node-postgres.com/apis/pool).
