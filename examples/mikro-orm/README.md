# MikroORM example

This isolated example pins MikroORM 6.6.17 (`@mikro-orm/core` and `@mikro-orm/postgresql`) and node-postgres 8.23.0 with its own `package-lock.json`, separate from the root development dependencies. Each actor gets its own MikroORM instance whose pool holds one connection. MikroORM 6.6.17 declares Node.js `>=18.12.0`; the example was qualified on Node.js 22.18.0 and 24.7.0.

`@mikro-orm/postgresql` 6.6.17 depends on exactly pg 8.20.0, which npm installs under `node_modules/@mikro-orm/postgresql/node_modules/pg`. MikroORM uses that copy only for `pg.TypeOverrides` and `escapeLiteral`. Connections are opened by Knex 3.2.10, an exact dependency of `@mikro-orm/knex` 6.6.17, which loads the application's pg 8.23.0. The gate checks that resolution.

## Use the actor helper

Pass the actor context, your entities and an operation. The operation receives a forked EntityManager:

```js
import { EntitySchema } from '@mikro-orm/core';
import { withMikroOrmActor } from './connection.mjs';

const Counter = new EntitySchema({ name: 'Counter', tableName: 'counter', properties: {
  id: { type: 'integer', primary: true, autoincrement: false }, value: { type: 'integer' },
} });

async function actor(context) {
  return withMikroOrmActor(context, [Counter], async em => (await em.findOneOrFail(Counter, 1)).value);
}
```

Await every query. Non-database work must observe `context.signal`; the helper cannot interrupt an arbitrary application promise.

The helper calls `MikroORM.init()` with `clientUrl: context.connectionString`, your entities, `pool: { min: 0, max: 1 }` and `application_name: 'interleave-mikro-orm'` in `driverOptions.connection`, then `orm.connect()`. It passes `connect: false` to `init()` so that it owns the ORM before the first command; `init()` followed by `connect()` sends the same commands as the default `init()`. It also sets `ensureDatabase: false`, explained below. Everything else is MikroORM's default, including its transaction API, implicit transactions around `flush()` and its connection check.

node-postgres's public `stream` option, which MikroORM passes through Knex to pg's `Client`, hands every socket the actor opens to the helper. When the run is cancelled or reaches its deadline, the helper destroys those sockets, so a command that the proxy has not released yet rejects at once. MikroORM's `connect()` reports a failed connection check without throwing, so an actor interrupted there rejects with the abort reason. After the operation settles, the helper calls `orm.close(true)`, destroys any socket that is still open and waits for every socket to close. Cleanup failures reject the actor together with the operation's own error.

MikroORM parses the connection URL itself and does not pass its `sslmode=disable` to node-postgres, which then reads `PGSSLMODE` from the environment. Supervised file runs remove that variable before scenario code starts. For an in-process scenario object, unset it yourself. During `init()`, MikroORM also reads a `.env` file in the working directory and `MIKRO_ORM_*` environment variables. Interleave records neither, so keep them out of the environment where you record and replay.

## Startup commands

MikroORM sends two commands before the first application query, and an explicit plan needs two choices per actor for them: `select version();`, Knex's version check on the first connection, and `select 1`, MikroORM's connection check in `connect()`. Both use the simple query protocol.

### Why the helper turns off `ensureDatabase`

With MikroORM's default `ensureDatabase: true`, `connect()` also sends `select 1 from pg_database where datname = '<database>'` between those two commands, with the database name written into the SQL. Interleave creates a database with a new random name for every run, so this command's text, and therefore its fingerprint, differs on every replay. With the default left on, a recorded lost update on PostgreSQL 16.15 had that command at steps 2 and 3, and its exact replay stopped as `incompatible` with "Replay query or actor startup identity changed for alice at step 2". Interleave creates and drops the database itself, so the check has nothing to do in a scenario, and the helper sets `ensureDatabase: false`. Interleave does not normalize SQL text; a simple query's fingerprint covers its full text.

## Scenario module

`scenario.mjs` exports `createMikroOrmScenario(behavior)` and, as its default export, the unsafe `lost-update` scenario. Setup creates the tables `counter`, `entries` and `attempts`; `EntitySchema` definitions map them with application-assigned primary keys. The invariant checks the final rows.

| Behavior | Application code | Expected outcome |
| --- | --- | --- |
| `lost-update` | `em.findOneOrFail(Counter, 1)`, then `counter.value = read + 1` and `em.flush()` | Violation. Bob's UPDATE waits for alice's flush transaction, then writes the same stale value |
| `atomic` | `em.findOneOrFail(Counter, 1)`, then `counter.value = raw('value + 1')` and `em.flush()` | Passes. MikroORM reads the new value back with `returning` |
| `crud-rollback` | `em.transactional()` creates an entry, reads it with `refresh: true`, changes it and reads it again. After `em.clear()`, a second transaction creates a marker row and then a duplicate primary key, each with its own `flush()`. Then `findOneOrFail`, `count` and `nativeDelete` run on the same connection | Passes with SQLSTATE 23505 (`error.code` of `UniqueConstraintViolationException`) caught and the marker rolled back |
| `serializable-retry` | `em.transactional(handler, { isolationLevel: IsolationLevel.SERIALIZABLE })` creates an attempt marker, flushes, reads the counter and adds one, which the closing flush writes. On SQLSTATE 40001 (`DeadlockException`) it clears the EntityManager, checks that its marker is gone and restarts the whole transaction, up to three attempts | Passes. Each actor's committed marker names its final attempt |
| `serializable-error` | The same transaction without retry | The 40001 rejects the actor. Interleave reports `actor-error` and does not evaluate the invariant |

The atomic behavior keeps the read, so it sends the same number of commands as the unsafe one. A guided replay of a recorded lost update therefore follows the recorded actor order to the end; a repair that sent fewer commands would make that guided run `incompatible`.

MikroORM writes parameter values into the SQL before Knex runs it, so every application command uses the simple query protocol with literal values, for example `select "c0".* from "counter" as "c0" where "c0"."id" = 1 limit 1` and `update "counter" set "value" = 1 where "id" = 1`. The atomic write is `update "counter" set "value" = value + 1 where "id" = 1 returning "value"`. `flush()` outside a transaction sends `BEGIN;` and `COMMIT;` around its changes; a serializable transaction starts with `BEGIN TRANSACTION ISOLATION LEVEL serializable;`, and a failed one ends with `ROLLBACK`.

## Qualification gate

Run the gate from the repository root on Node.js 22.18.0 or 24.7.0. It installs this example's lock and the Interleave archive under test into a new application under the evidence directory; the example's own `node_modules` is not used. The install needs npm registry access or a warm npm cache, and the export check downloads the locked archives from `registry.npmjs.org`.

```sh
npm ci --ignore-scripts
npm run build
mkdir -p ../interleave-runtime
npm pack --ignore-scripts --pack-destination ../interleave-runtime
INTERLEAVE_ORM=mikro-orm \
TEST_DATABASE_URL='<dedicated PostgreSQL administrator URL>' \
INTERLEAVE_ORM_RUNTIME_ARCHIVE=../interleave-runtime/pavangupta352-interleave-<version>.tgz \
INTERLEAVE_ORM_EVIDENCE=../mikro-orm-evidence \
npm run test:orms
```

`INTERLEAVE_ORM_EVIDENCE` must name a new directory with no `node_modules` directory in any parent, because Node.js would resolve optional peer drivers from there. Set `INTERLEAVE_ORM_RUNTIME_SHA256` to require an exact archive hash. The [compatibility guide](../../docs/compatibility.md#sequelize-knex-and-mikroorm) lists the 14 checks and the evidence files the gate keeps.

Observed on 25 October 2026 on macOS arm64 with official Docker images and the Interleave 0.2.0 archive built from commit `d572265`, one row at a time:

| Node.js / npm | PostgreSQL 16.15 | PostgreSQL 17.11 | PostgreSQL 18.6 |
| --- | --- | --- | --- |
| 22.18.0 / 10.9.3 | 14/14, 62 s | 14/14, 63 s | 14/14, 66 s |
| 24.7.0 / 11.5.1 | 14/14, 60 s | 14/14, 72 s | 14/14, 94 s |

Each row recorded, replayed, minimized and exported against its own server. The recorded source identity was 11,820,145 bytes in 2,619 files. Minimization reduced the 12 recorded choices to none in 5 attempts, because the fair fallback alone reproduces the lost update. The export bundled 80 original archives.

## Limits

- Closing a client does not send a PostgreSQL CancelRequest. A backend that waits for a lock can keep waiting after the actor settles, until its blocker finishes or Interleave drops the generated database.
- The retry handles SQLSTATE 40001 only, and the gate exercises it where the competing UPDATE fails. MikroORM maps deadlocks (40P01) to the same `DeadlockException`; neither deadlocks nor serialization failures at COMMIT nor retry backoff were exercised.
- Knex 3.2.10 loads the connecting pg with a computed `require`. The recording hashes pg 8.23.0 as part of Interleave's runtime, which depends on the same installation, and through pg-pool's peer dependency. With another pg version, check what the recording covers; see the [compatibility guide](../../docs/compatibility.md#sequelize-knex-and-mikroorm).
- Not qualified: decorators and other metadata providers, relations, cascades and batched inserts of several entities, `em.lock()`, the schema generator, migrations, the metadata and result caches, read replicas, MikroORM 7, a pool larger than one connection, and exact replay across Node.js or PostgreSQL versions.

Public API references: [MikroORM configuration](https://mikro-orm.io/docs/configuration), [MikroORM transactions](https://mikro-orm.io/docs/transactions), [EntityManager](https://mikro-orm.io/docs/entity-manager) and [node-postgres client options](https://node-postgres.com/apis/client).
