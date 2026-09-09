# Postgres.js transaction-conflict qualification — 9 September 2026

This local qualification covers **Postgres.js 3.4.9, Node.js 24.7.0 and PostgreSQL 16.13** through `describe-flush-v1`. It adds real deadlock and serialization-failure checks to the [existing staged driver qualification](postgresjs-describe-flush-2026-09-09.md). These programmatic scenarios establish constructed caller retry behavior; they do not qualify a particular third-party application or its retry policy, or reproduce a historical application bug.

The [new integration tests](../../test/postgresjs-transaction-conflicts.integration.test.ts) use the actual public `sql.begin` API, one connection per actor (`max: 1`), plaintext transport, and explicit `fetch_types: false`. Both default preparation (`prepare: true`) and `prepare: false` are checked. Actors use the documented AbortSignal handler with public `sql.end({ timeout: 0 })`, followed by awaited `sql.end({ timeout: 1 })` in `finally`. Server deadlock settings, driver internals, SQL frames, clocks and parameter values are unchanged.

## Measured behavior

| Case, in both preparation modes | Required observations |
| --- | --- |
| Handled deadlock, SQLSTATE `40P01` | Two transactions update rows in opposite order. One actual backend error leaves transaction state `E`; Postgres.js automatically rolls it back to `I`. A subsequent parameterized query succeeds on that actor. The other transaction commits, and only its increments remain. |
| Unhandled deadlock | The same original error is propagated after the rollback check and subsequent query. The result is `actor-error`, the invariant is skipped, and the other actor completes. |
| Whole-transaction retry after `40001` | Both serializable transactions read counter value zero. The losing transaction rolls back, including a marker write performed before the conflicting UPDATE. Its next public `sql.begin` callback re-reads value one and commits value two. Both actors' markers record one committed attempt each. |
| Unhandled serialization failure | Automatic rollback and subsequent SQL still succeed; the original `40001` reaches the actor result. The invariant is skipped. |

Each error is supported by a real lock wait and backend ErrorResponse. Every completed record is checked against the artifact schema, including ReadyForQuery transaction state and complete cleanup. The serialization cases each complete **two exact replays**, preserving the query and stage identities, original SQLSTATE and actor results. Prepared retries reuse the actual cached read statement; `prepare: false` repeats the real description and execution exchange.

## Deadlock replay boundary

PostgreSQL owns victim selection; applications should not rely on which transaction it aborts. [PostgreSQL's deadlock documentation](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-DEADLOCKS) states this boundary.

The initial probe reproduced a victim switch with identical released commands and starting identities. The recording aborted Bob and next committed Alice; replay aborted Alice and attempted its automatic rollback. Interleave correctly returned `incompatible` before forwarding that changed command. Successful deadlock replays were also observed. This does not establish deterministic victim selection.

The regression accepts a replay only when it either completes the full recorded contract or proves this specific divergence: a real `40P01` moves to the other actor, all released identities before the first COMMIT/ROLLBACK match, and the driver's public `debug` callback captures the opposite command at that exact rejected gate. The diagnostic callback retains at most 32 command strings per actor and changes no database inputs. Other incompatibilities, timeouts or incomplete cleanup fail the test.

## Verification and limits

The final focused check passed **23 tests in four files**, plus TypeScript checking: the new conflict tests, existing Postgres.js runner/replay tests, contained shutdown tests and node-postgres conflict tests. The eight new cases ran 24 fresh databases. All captured names were independently absent afterward; the cleanup hook also fails if it must remove a leftover.

In that final check, the eight deadlock replay attempts produced four complete matching outcomes and four independently proven victim-switch incompatibilities. All eight serialization replay attempts completed with their expected passing or actor-error outcomes. These counts describe this run, not a success-rate claim.

This addition covers programmatic object scenarios. Installed-package, source-bound and offline replay remain the separate evidence in the existing qualification. It does not extend this local result to every server version, isolation pattern, Postgres.js feature or application retry policy.
