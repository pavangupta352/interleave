# Ordinary Drizzle and Kysely queries

These constructed examples call Drizzle 0.45.2's node-postgres adapter and Kysely 0.29.5's PostgresDialect against real PostgreSQL. Each actor owns a separate pg 8.23.0 Pool with `max: 1` and closes its checked-out connections on cancellation. They demonstrate application integration patterns and are not historical bug reports.

From a repository checkout with development dependencies installed:

```sh
npm run test:integration -- test/ordinary-orm.integration.test.ts
npm run test:integration -- test/ordinary-orm-packaged.integration.test.ts
```

With Docker running and `TEST_DATABASE_URL` unset, each command provisions and removes its own PostgreSQL server. To use an existing dedicated administrator endpoint, set `TEST_DATABASE_URL` explicitly. The [compatibility guide](../../docs/compatibility.md) describes server selection and fixture boundaries.

`createOrmScenario('drizzle', behavior)` and `createOrmScenario('kysely', behavior)` provide these workloads. The table describes the schedules exercised by the tests; other schedules can produce different valid outcomes.

| Behavior | Application calls and expected evidence |
| --- | --- |
| `lost-update` (default) | Both actors read zero before either writes. The final value is one and the invariant fails. |
| `atomic` | Each public UPDATE increments the existing value. The final value is two. |
| `crud-rollback` | INSERT and UPDATE commit; a later duplicate-key error (`23505`) rolls back an earlier write in the same transaction. SELECT and DELETE then succeed. |
| `serializable-retry` | PostgreSQL rejects an overlapping update with `40001`. The whole transaction retries with a fresh read; the failed attempt's audit row is absent. |
| `serializable-error` | The same serialization failure reaches the caller after rollback. Interleave reports `actor-error` and skips the invariant. |

Both serializable workloads also pass when one transaction completes before the other begins: each reads the current value, commits once and needs no retry. Their invariant checks the final counter and committed audit rows. The overlapping tests separately require the observed serialization error and retry behavior.

The native integration tests also exercise exact replay, choice minimization, cooperative cancellation and deadlines. The installed-package test covers source drift rejection and an offline exported replay. Passing a finite set of schedules establishes only those observed executions.

The aggregate scenario module imports both ORMs, so its clean application fixture deliberately installs both pinned packages. Interleave's main package requires neither ORM for other scenarios. The reusable operation and connection ownership code is in [drizzle.ts](drizzle.ts), [kysely.ts](kysely.ts) and [connection.ts](connection.ts); adapt the chosen caller to your own application.

This example does not qualify every ORM API or driver, shared multi-connection pools, migrations, savepoints, serverless transports or another database engine. Public upstream APIs are documented in the [Drizzle transaction guide](https://orm.drizzle.team/docs/transactions) and [Kysely API reference](https://kysely-org.github.io/kysely-apidoc/classes/Kysely.html).
