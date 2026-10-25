# Knex example

This isolated example pins Knex 3.3.0 and node-postgres 8.23.0 with its own `package-lock.json`, separate from the root development dependencies. Each actor gets its own Knex instance whose pool holds one connection. Knex 3.3.0 declares Node.js `>=16`; the example was qualified on Node.js 22.18.0, 24.7.0 and 26.12.1. The [Knex migration-lock case study](../historical/knex-migration-lock/README.md), about a race inside Knex itself, is separate from this example.

## Use the actor helper

Pass the actor context and an operation that receives the actor's Knex instance:

```js
import { withKnexActor } from './connection.mjs';

async function actor(context) {
  return withKnexActor(context, async db => (await db('counter').where({ id: 1 }).first('value')).value);
}
```

Await every query. Non-database work must observe `context.signal`; the helper cannot interrupt an arbitrary application promise.

The helper creates `knex({ client: 'pg', ... })` with `connection: { connectionString: context.connectionString, application_name: 'interleave-knex' }` and `pool: { min: 0, max: 1 }`. Knex's default pool keeps at least two connections, and tarn rejects a minimum above the maximum. Everything else is Knex's default, including its transaction API and its version check. Knex 3.3.0's `connectionPool` option for an external `pg.Pool` is not used.

node-postgres's public `stream` option, which Knex passes to pg's `Client` with the rest of the connection object, hands every socket the actor opens to the helper. When the run is cancelled or reaches its deadline, the helper destroys those sockets, so a command that the proxy has not released yet rejects at once. After the operation settles, the helper calls `db.destroy()`, destroys any socket that is still open and waits for every socket to close. Cleanup failures reject the actor together with the operation's own error.

## Startup commands

Knex sends one command before the first application query: `select version();`, its version check on the first connection of each Knex instance. It uses the simple query protocol. An explicit plan needs one choice per actor for it. Knex sets no `search_path` unless `searchPath` is configured.

## Scenario module

`scenario.mjs` exports `createKnexScenario(behavior)` and, as its default export, the unsafe `lost-update` scenario. Setup creates the tables `counter`, `entries` and `attempts`, and the invariant checks the final rows.

| Behavior | Application code | Expected outcome |
| --- | --- | --- |
| `lost-update` | `first('value')`, then `update({ value: read + 1 })` | Violation when both reads precede both writes |
| `atomic` | `first('value')`, then `increment('value', 1).returning('value')` | Passes, with the written values 1 and 2 |
| `crud-rollback` | `db.transaction()` runs `insert`, `first`, `update` and `first`. A second transaction inserts a marker row and then a duplicate primary key. Then `first`, `count` and `del` run on the same connection | Passes with SQLSTATE 23505 (`error.code`) caught and the marker rolled back |
| `serializable-retry` | `db.transaction(handler, { isolationLevel: 'serializable' })` inserts an attempt marker, reads the counter and writes it plus one. On SQLSTATE 40001 it checks that its marker is gone and restarts the whole transaction, up to three attempts | Passes. Each actor's committed marker names its final attempt |
| `serializable-error` | The same transaction without retry | The 40001 rejects the actor. Interleave reports `actor-error` and does not evaluate the invariant |

The atomic behavior keeps the read, so it sends the same number of commands as the unsafe one. A guided replay of a recorded lost update therefore follows the recorded actor order to the end; a repair that sent fewer commands would make that guided run `incompatible`.

Query-builder statements with values use the extended query protocol with `$n` parameters, including `first()` (`select "value" from "counter" where "id" = $1 limit $2`), `count()` and `del()`. The atomic write is `update "counter" set "value" = "value" + $1 where "id" = $2 returning "value"`. Transactions send `BEGIN;` or `BEGIN TRANSACTION ISOLATION LEVEL serializable;`, then `COMMIT;` or `ROLLBACK` as simple queries.

## Qualification gate

Run the gate from the repository root on Node.js 22.18.0, 24.7.0 or 26.12.1. The gate uses the npm inside the selected Node.js installation, which can differ from the `npm` on your PATH; to check npm 12, install it there with `npm install --global npm@12.2.1`. It installs this example's lock and the Interleave archive under test into a new application under the evidence directory; the example's own `node_modules` is not used. The install needs npm registry access or a warm npm cache, and the export check downloads the locked archives from `registry.npmjs.org`.

```sh
npm ci --ignore-scripts
npm run build
mkdir -p ../interleave-runtime
npm pack --ignore-scripts --pack-destination ../interleave-runtime
INTERLEAVE_ORM=knex \
TEST_DATABASE_URL='<dedicated PostgreSQL administrator URL>' \
INTERLEAVE_ORM_RUNTIME_ARCHIVE=../interleave-runtime/pavangupta352-interleave-<version>.tgz \
INTERLEAVE_ORM_EVIDENCE=../knex-evidence \
npm run test:orms
```

`INTERLEAVE_ORM_EVIDENCE` must name a new directory with no `node_modules` directory in any parent, because Node.js would resolve Knex's optional peer drivers from there. Set `INTERLEAVE_ORM_RUNTIME_SHA256` to require an exact archive hash. The [compatibility guide](../../docs/compatibility.md#sequelize-knex-and-mikroorm) lists the 14 checks and the evidence files the gate keeps.

Observed on 25 October 2026 on macOS arm64 with official Docker images and an archive of Interleave built from commit `d572265` (a 0.2 development build, before the cancel, COPY and Flush-stage work), one row at a time:

| Node.js / npm | PostgreSQL 16.15 | PostgreSQL 17.11 | PostgreSQL 18.6 |
| --- | --- | --- | --- |
| 22.18.0 / 10.9.3 | 14/14, 44 s | 14/14, 39 s | 14/14, 40 s |
| 24.7.0 / 11.5.1 | 14/14, 55 s | 14/14, 60 s | 14/14, 39 s |

Each row recorded, replayed, minimized and exported against its own server. The recorded source identity was 7,856,485 bytes in 1,704 files. Minimization reduced the 6 recorded choices to none in 4 attempts, because the fair fallback alone reproduces the lost update. The export bundled 38 original archives.

## Export

Knex 3.3.0 pins pg-connection-string 2.6.2, while node-postgres 8.23.0 uses its own 2.14.0, so this application's packages share no installed instance with Interleave's runtime. Export it with the original Interleave archive, `--runtime-archive <original.tgz>`, which selects the offline installation of the original application lock. Without the option, export still selects that installation, because the application took Interleave from a local archive, and asks for the archive unless it lies inside the application folder.

## Limits

- Closing a client does not send a PostgreSQL CancelRequest. A backend that waits for a lock can keep waiting after the actor settles, until its blocker finishes or Interleave drops the generated database.
- The retry handles SQLSTATE 40001 only, and the gate exercises it where the competing UPDATE fails. Deadlocks (40P01), serialization failures at COMMIT and retry backoff were not exercised.
- Knex loads pg with a computed `require` and lists it only in `peerDependenciesMeta`, so the recorded dependency graph does not include it. The recording still hashes pg 8.23.0 as part of Interleave's runtime, which depends on the same installation. With another pg version that coverage is lost; see the [compatibility guide](../../docs/compatibility.md#sequelize-knex-and-mikroorm).
- Not qualified: migrations and seeds, streams and `pg-query-stream`, `connectionPool`, `searchPath`, raw multi-statement queries, a pool larger than one connection, the `pg-native` bindings, and exact replay across Node.js or PostgreSQL versions.

Public API references: [Knex configuration](https://knexjs.org/guide/), [Knex transactions](https://knexjs.org/guide/transactions.html) and [node-postgres client options](https://node-postgres.com/apis/client).
