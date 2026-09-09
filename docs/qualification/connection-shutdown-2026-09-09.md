# Query-error shutdown and transaction qualification

Executed on 9 September 2026. This is development verification; stable release gates remain open.

The expanded CI matrix at commit `8067c7026525d41e871c71117c35483d8bb23afc` exposed a transport race: node-postgres can reject a query on PostgreSQL's ErrorResponse and immediately close the connection, before ReadyForQuery reaches the proxy. Interleave incorrectly treated that close as unfinished application work and sent a second error, which could crash the scenario worker.

The proxy now drains the actual ReadyForQuery after this specific error-and-Terminate sequence and retains the original SQLSTATE and transaction state. It handles frontend backpressure, rejects a backend that disconnects before completion, and rejects protocol data after Terminate. Other unfinished disconnects remain explicit failures. No database response or completion is synthesized.

| Verification | Observed result |
| --- | --- |
| Deterministic protocol regressions | Explicit error, frontend close, and final completion gates; backpressure and premature backend closure covered |
| PostgreSQL 18.6 / Node.js 24.7.0 focused integration | 34 tests passed |
| Concurrent real query-error executions | 80 of 80 returned actor-error, with no worker diagnostic output |
| Complete PostgreSQL 16.13 / Node.js 24.7.0 suite | 426 tests in 35 files passed in 80.69 seconds |
| Fresh Linux checkout: source identity and CLI checks | 66 tests passed with the existing 20-second per-test limit |

The fresh-checkout check also corrected a test fixture that assumed a private working directory existed. The cumulative CLI test was split into workflow, minimization-budget, and overwrite cases; application and test time limits were not increased.

Additional real transaction tests exercise opposing row updates that produce PostgreSQL `40P01`, both application-handled rollback and unhandled actor error, and serializable updates that produce `40001`. The retry case reruns the complete transaction using cached prepared statements, retains both increments, and passes two fresh exact replays with matching query identities. These are constructed engine qualification cases, not historical application bugs or file-export qualification.

The deadlock assertions deliberately do not select a victim: PostgreSQL makes that decision. The retry repeats the complete transaction, as described in PostgreSQL's [deadlock documentation](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-DEADLOCKS) and [serialization failure guidance](https://www.postgresql.org/docs/18/mvcc-serialization-failure-handling.html).

The full Node.js 22/24 and PostgreSQL 16/17/18 CI result is tracked separately in the repository's workflow history. A local result does not substitute for that matrix.
