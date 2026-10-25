# Sequelize example

This isolated example pins Sequelize 6.37.8 and node-postgres 8.23.0 with its own `package-lock.json`, separate from the root development dependencies. Each actor gets its own Sequelize instance whose pool holds one connection. Sequelize 6.37.8 declares Node.js `>=10`; the example was qualified on Node.js 22.18.0, 24.7.0 and 26.12.1. The [Sequelize `findCreateFind` case study](../historical/sequelize-find-create-find/README.md), about `findCreateFind` inside PostgreSQL transactions in Sequelize 6.7.0, is separate from this example.

## Use the actor helper

Pass the actor context and an operation that receives the actor's Sequelize instance. Define models inside the operation, because each actor has its own instance:

```js
import { DataTypes } from 'sequelize';
import { withSequelizeActor } from './connection.mjs';

async function actor(context) {
  return withSequelizeActor(context, async sequelize => {
    const Counter = sequelize.define('Counter', {
      id: { type: DataTypes.INTEGER, primaryKey: true }, value: DataTypes.INTEGER,
    }, { tableName: 'counter', timestamps: false });
    return (await Counter.findByPk(1)).value;
  });
}
```

Await every query. Non-database work must observe `context.signal`; the helper cannot interrupt an arbitrary application promise.

The helper creates `new Sequelize(context.connectionString, ...)` with `pool: { max: 1, min: 0 }`, `logging: false` and `application_name: 'interleave-sequelize'`. Everything else is Sequelize's default, including its transaction API, its query retry rules (which match only `SQLITE_BUSY`) and its startup commands. node-postgres's public `stream` option, which Sequelize passes through `dialectOptions`, hands every socket the actor opens to the helper. When the run is cancelled or reaches its deadline, the helper destroys those sockets, so a command that the proxy has not released yet rejects at once. After the operation settles, the helper calls `sequelize.close()`, destroys any socket that is still open and waits for every socket to close. Cleanup failures reject the actor together with the operation's own error.

Sequelize parses the connection URL itself and does not pass its `sslmode=disable` to node-postgres, which then reads `PGSSLMODE` from the environment. Supervised file runs remove that variable before scenario code starts. For an in-process scenario object, unset it yourself.

## Startup commands

Sequelize sends three commands before the first application query, on two connections, and an explicit plan needs three choices per actor for them:

| Connection | Command | Purpose |
| --- | --- | --- |
| 0 | `SET client_min_messages TO warning;SET TIME ZONE INTERVAL '+00:00' HOUR TO MINUTE;` | Session settings for every new connection |
| 0 | `WITH ranges AS (...) SELECT pg_type.typname, ... WHERE (pg_type.typtype IN('b', 'e'));` | Type OIDs for Sequelize's parsers, once per Sequelize instance |
| 1 | `SET client_min_messages TO warning;SET TIME ZONE INTERVAL '+00:00' HOUR TO MINUTE;` | The same settings on the pool connection |

Connection 0 is a separate version connection that Sequelize opens, uses and closes before it creates its pool connection, so the two never overlap. The server version comes from PostgreSQL's ParameterStatus message, so there is no `SHOW` command. Both connections present the same startup parameters. All three commands use the simple query protocol.

## Scenario module

`scenario.mjs` exports `createSequelizeScenario(behavior)` and, as its default export, the unsafe `lost-update` scenario. Setup creates the tables `counter`, `entries` and `attempts`; the models map them with Sequelize's timestamps turned off. The invariant checks the final rows.

| Behavior | Application code | Expected outcome |
| --- | --- | --- |
| `lost-update` | `findByPk(1)`, then `counter.value = read + 1` and `save()` | Violation when both reads precede both writes |
| `atomic` | `findByPk(1)`, then `counter.increment('value')` | Passes. The instance takes the new value from `RETURNING *` |
| `crud-rollback` | A managed `sequelize.transaction()` runs `create`, `findByPk`, `update` and `findByPk`. A second one creates a marker row and then a duplicate primary key. Then `findByPk`, `count` and `destroy` run on the same connection | Passes with SQLSTATE 23505 (`error.parent.code`) caught and the marker rolled back |
| `serializable-retry` | A managed transaction with `isolationLevel: SERIALIZABLE` creates an attempt marker, reads the counter and saves it plus one. On SQLSTATE 40001 it checks that its marker is gone and restarts the whole transaction, up to three attempts | Passes. Each actor's committed marker names its final attempt |
| `serializable-error` | The same transaction without retry | The 40001 rejects the actor. Interleave reports `actor-error` and does not evaluate the invariant |

The atomic behavior keeps the read, so it sends the same number of commands as the unsafe one. A guided replay of a recorded lost update therefore follows the recorded actor order to the end; a repair that sent fewer commands would make that guided run `incompatible`.

The commands Sequelize sends after startup:

| Code | SQL | Protocol |
| --- | --- | --- |
| `Counter.findByPk(1)` | `SELECT "id", "value" FROM "counter" AS "Counter" WHERE "Counter"."id" = 1;` | Simple, value inlined |
| `counter.save()` | `UPDATE "counter" SET "value"=$1 WHERE "id" = $2` | Extended |
| `counter.increment('value')` | `UPDATE "counter" SET "value"="value"+ 1 WHERE "id" = 1 RETURNING *` | Simple |
| `Entry.create()` | `INSERT INTO "entries" ("id","value") VALUES ($1,$2) RETURNING "id","value";` | Extended |
| `Entry.update()` | `UPDATE "entries" SET "value"=$1 WHERE "id" = $2` | Extended |
| `Entry.count()` | `SELECT count(*) AS "count" FROM "entries" AS "Entry" WHERE "Entry"."id" = 11;` | Simple |
| `Entry.destroy()` | `DELETE FROM "entries" WHERE "id" = 1` | Simple |
| Transactions | `START TRANSACTION;`, `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;`, `COMMIT;`, `ROLLBACK;` | Simple |

## Qualification gate

Run the gate from the repository root on Node.js 22.18.0, 24.7.0 or 26.12.1. The gate uses the npm inside the selected Node.js installation, which can differ from the `npm` on your PATH; to check npm 12, install it there with `npm install --global npm@12.2.1`. It installs this example's lock and the Interleave archive under test into a new application under the evidence directory; the example's own `node_modules` is not used. The install needs npm registry access or a warm npm cache, and the export check downloads the locked archives from `registry.npmjs.org`.

```sh
npm ci --ignore-scripts
npm run build
mkdir -p ../interleave-runtime
npm pack --ignore-scripts --pack-destination ../interleave-runtime
INTERLEAVE_ORM=sequelize \
TEST_DATABASE_URL='<dedicated PostgreSQL administrator URL>' \
INTERLEAVE_ORM_RUNTIME_ARCHIVE=../interleave-runtime/pavangupta352-interleave-<version>.tgz \
INTERLEAVE_ORM_EVIDENCE=../sequelize-evidence \
npm run test:orms
```

`INTERLEAVE_ORM_EVIDENCE` must name a new directory with no `node_modules` directory in any parent, because Node.js would resolve Sequelize's optional peer drivers from there. Set `INTERLEAVE_ORM_RUNTIME_SHA256` to require an exact archive hash. The [compatibility guide](../../docs/compatibility.md#sequelize-knex-and-mikroorm) lists the 14 checks and the evidence files the gate keeps.

Observed on 25 October 2026 on macOS arm64 with official Docker images and an archive of Interleave built from commit `d572265` (a 0.2 development build, before the cancel, COPY and Flush-stage work), one row at a time:

| Node.js / npm | PostgreSQL 16.15 | PostgreSQL 17.11 | PostgreSQL 18.6 |
| --- | --- | --- | --- |
| 22.18.0 / 10.9.3 | 14/14, 108 s | 14/14, 119 s | 14/14, 65 s |
| 24.7.0 / 11.5.1 | 14/14, 64 s | 14/14, 59 s | 14/14, 58 s |

Each row recorded, replayed, minimized and exported against its own server. The recorded source identity was 20,541,744 bytes in 2,906 files. Minimization reduced the 10 recorded choices to none in 5 attempts, because the fair fallback alone reproduces the lost update. The export bundled 35 original archives.

## Limits

- Closing a client does not send a PostgreSQL CancelRequest. A backend that waits for a lock can keep waiting after the actor settles, until its blocker finishes or Interleave drops the generated database.
- The retry handles SQLSTATE 40001 only, and the gate exercises it where the competing UPDATE fails. Deadlocks (40P01), serialization failures at COMMIT and retry backoff were not exercised.
- Sequelize loads pg with a computed `require` and lists it only in `peerDependenciesMeta`, so the recorded dependency graph does not include it. The recording still hashes pg 8.23.0 as part of Interleave's runtime, which depends on the same installation. With another pg version that coverage is lost; see the [compatibility guide](../../docs/compatibility.md#sequelize-knex-and-mikroorm).
- Not qualified: associations, hooks, scopes, `findOrCreate`, `upsert`, paranoid models, CLS transactions, read replicas, `sync()` and migrations, the `pg-native` bindings, Sequelize 7, a pool larger than one connection, and exact replay across Node.js or PostgreSQL versions.

Public API references: [Sequelize transactions](https://sequelize.org/docs/v6/other-topics/transactions/), [Sequelize connection options](https://sequelize.org/api/v6/class/src/sequelize.js~sequelize#instance-constructor-constructor) and [node-postgres client options](https://node-postgres.com/apis/client).
