# TypeORM actor lifecycle example

This isolated example uses TypeORM **1.1.1**, node-postgres **8.23.0**, and one PostgreSQL DataSource per actor. Its lifecycle qualification runs on **Node22.18.0 / PostgreSQL16**. It is separate from the Drizzle/Kysely examples and the root development dependencies. TypeORM1.1.1 does not support Node24.7.0.

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

The helper uses TypeORM's public PostgreSQL `driver` option to own its pg Pool before initialization returns. Each actor has poolSize1, a five-second connection/acquisition timeout, and a single QueryRunner for its operation. Synchronization, migrations and extension installation are disabled. TypeORM's real startup queries remain part of the scheduled execution. There is no global driver mutation or access to TypeORM's internal connection fields.

When cancellation arrives after acquisition, the helper destroys leased clients through pg's public release callback. TypeORM can then unwind, release its runner and destroy its DataSource. Partial initialization and late acquisitions are also cleaned up, and real SQL/client errors reject the operation.

Two limits matter when interpreting cancellation:

- **Acquisition before a client is available can take up to the configured five-second pg timeout.** A connection that arrives after cancellation is destroyed before TypeORM uses it. This is not a promise of immediate in-process settlement during network startup.
- **Closing a client does not send PostgreSQL CancelRequest.** A server statement waiting for a lock can remain after the actor's promise and pool have closed. Interleave's owned-database cleanup supplies containment. Client settlement and server/database absence are separate checks.

Run the separate lifecycle job from the repository root, with Node22.18.0 selected and a dedicated PostgreSQL16 administrator database:

```sh
npm ci --ignore-scripts
npm run build
npm ci --prefix examples/typeorm --ignore-scripts
TEST_DATABASE_URL='<dedicated PostgreSQL administrator URL>' node scripts/test-typeorm.mjs
```

Use credentials for your dedicated test server. The job creates and removes its own generated application databases; it checks their absence independently. A different Node version fails explicitly. The job is not silently included or skipped in the root suite. Its source-bound check retains a copied exact-pin consumer under the system temporary directory, or under `INTERLEAVE_TYPEORM_RUN_DIRECTORY` when supplied. `INTERLEAVE_TYPEORM_JOURNAL` optionally records raw observations and run artifacts.

The checks cover normal rows, wire SQLSTATE23505, real lock waits, cancellation/deadline actor settlement, queued initialization and queries, initial acquisition/timeout, queued QueryRunner acquisition, checked-out client failure, and in-process/supervised containment. They do not qualify transactions or retry logic, arbitrary TypeORM APIs, other database engines, native drivers, replicas, migrations, shared pools, or a Node/PostgreSQL matrix. The earlier installed-consumer export gate used a different normal-path fixture; this lifecycle job does not by itself requalify export/replay for this helper.

Public API references: [TypeORM QueryRunner](https://typeorm.io/docs/query-runner/), [TypeORM PostgreSQL options](https://typeorm.io/docs/drivers/postgres/), [pinned PostgreSQL driver option](https://github.com/typeorm/typeorm/blob/1.1.1/src/driver/postgres/PostgresDataSourceOptions.ts), and [pg Pool acquisition/release](https://node-postgres.com/apis/pool).
