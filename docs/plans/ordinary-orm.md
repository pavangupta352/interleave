# Ordinary PostgreSQL application calls

## Contract

Qualify the pinned Drizzle 0.45.2 node-postgres adapter and Kysely 0.29.5 PostgresDialect through ordinary public query-builder and transaction APIs. Each actor owns a separate pg 8.23.0 Pool with max: 1. Interleave continues to schedule actual PostgreSQL wire releases; it does not implement an ORM adapter or emulate database results.

Examples live in `examples/orm/`, with separate driver modules and a small owned-Pool lifecycle module. They use the actor URL and AbortSignal and return serializable application observations. The shared fixture owns a counter and transaction audit rows. No dependency, core scheduler contract, vendor code or fixture profile changes are required.

## Acceptance sequence

1. Establish a real failing test for each ORM: both public SELECT calls read zero before either public UPDATE, the invariant sees one, actual parameterized SQL is present, cleanup is independently absent. Add the implementations only after RED.
2. Exact replay retains command, actor and failure identity; minimization verifies the same invariant and removes explicit ordering choices without removing SQL. An atomic public UPDATE preserves two under the same actor ordering, with freshly observed results.
3. Exercise INSERT/UPDATE/SELECT/DELETE with returned rows, a transaction that commits, and a real unique-key failure that rolls back prior writes. A subsequent query confirms recovery. Do not treat a swallowed unknown exception as a pass.
4. Force actual 40001 in serializable transactions, check rollback of prior audit INSERT, rerun the entire callback with fresh SELECT, and distinguish exhausted/unhandled failure from successful retry. Capture exact replay. Deadlock victim selection and savepoint coverage remain separate work.
5. Interrupt a genuinely queued public query, then test the real deadline path. Observe the backend before interruption and independently verify owned database absence and actor termination. No sleeps as race orchestration.
6. Install the built package and optional driver in a clean ordinary application, record/exact/minimize/export and offline installed replay. Verify original bytes/source/dependency identity, actual source drift rejection before load, and cleanup. Qualify both supported Node versions and native PostgreSQL matrix before broadening public support claims.

Meaningful integration tests go in `test/ordinary-orm.integration.test.ts`; installed coverage is separate. Tests may observe a proxy queue for deterministic interruption, but SQL and database outcomes remain real. Retain failed attempts and raw evidence privately. Independent review precedes integration; current f66 candidate evidence remains immutable. No historical/comparative execution is part of this work.

## Open boundaries

This work does not qualify every ORM API, implicit/shared multi-connection pools, savepoints, migrations, serverless transports, another Drizzle driver, COPY, TLS, Windows, other databases or another language. Those remain explicit expansion tasks. The example must not be presented as a historical bug or a benchmark.
