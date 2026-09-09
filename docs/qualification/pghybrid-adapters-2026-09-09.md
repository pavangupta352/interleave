# pghybrid public adapters and caller lifecycle — 9 September 2026

This adds real public adapter checks to the existing PostgreSQL 17 / pgvector
0.8.6 workload. It is constructed compatibility evidence. The unchanged library
generates the SQL; no executor stub, copied query or historical defect is used.

## Source and environment

The pghybrid pin remains version **0.1.4**, upstream commit
`6b12e4c0d8bb25957554c41ac12c56653efad49d`. Its original archive SHA-256 is
`6e5783cbc6496c74d47b213ab166668cf2929a0e80e5831b8abcf521d0b117c9`.
All nine extracted files, the MIT licenses, twelve copied documents and
`unitVector` values remain unchanged. The [original source manifest](../../examples/pghybrid/vendor/SOURCE.json)
and original example lock remain intact. New caller versions are a September
2026 qualification resolution, recorded separately in the repository lock and
each newly installed test application's lock.

| Public factory | Actual caller | Exact version | Protocol |
| --- | --- | --- | --- |
| `forPg` | `pg.Pool`, plus supplemental `pg.Client` | pg 8.23.0 / pg-pool 3.14.0 | `sync-cycle-v1` |
| `forPostgresJs` | Postgres.js `sql.unsafe(query, params)` | postgres 3.4.9 | `describe-flush-v1` |
| `forDrizzle` | `drizzle-orm/node-postgres` with real Pool `$client` | drizzle-orm 0.45.2 / pg 8.23.0 | `sync-cycle-v1` |
| `forKysely` | `Kysely` with `PostgresDialect` and real Pool | kysely 0.29.5 / pg 8.23.0 | `sync-cycle-v1` |

The database is PostgreSQL **17.11**, pgvector **0.8.6**, from
`pgvector/pgvector:0.8.6-pg17-bookworm`, Linux arm64. The measured image digest is
`sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`.
Both Node.js **24.7.0** / npm **11.5.1** and Node.js **22.18.0** / npm **10.9.3**
executed the same source and compiled runtime. This record adds no server,
vector version or image-platform profile.

Drizzle and Kysely are exact development-only additions. Every earlier lock
package record remains unchanged, including all 26 optional platform bindings
that npm initially removed during the dependency update. The optional aggregate
example imports pg, postgres, Drizzle and Kysely at module load, and the fresh
test applications explicitly install all four. The core and basic forPg example
do not acquire an ORM runtime dependency.

## Real checks

The [adapter tests](../../test/pghybrid-adapters.pgvector.integration.test.ts)
exercise five caller arrangements:

- Each actor searches twice through the same caller, closes it, opens a fresh
  caller on its actor URL and searches again. Two fresh exact replays compare
  the fixture, startup generations, released query identities and returned
  titles. Scores and fused scores must be finite and positive; ranks and result
  classification must have their actual supported shapes.
- A configuration naming a missing table produces real SQLSTATE **42P01**
  through the unchanged public factory. Handled errors are followed by two
  successful searches on the same caller object. Unhandled errors remain
  `actor-error` and skip the invariant. Pool.query-based callers retire the
  failed connection; Client and Kysely recovery retain theirs.
- Signal and deadline tests interrupt a queued caller operation while another
  actor holds the readiness boundary. They require inconclusive evidence,
  rejected caller completion and exact cleanup. The supported Postgres.js case
  first completes its actual default type discovery.
- The default whole-cycle profile rejects actual Postgres.js Flush traffic;
  selecting the staged profile is required. Changed document content is
  incompatible before any replayed adapter query is released.

All callers use public close APIs and `finally`. The helper additionally waits
for public Client `end` events observed through Pool `connect`: pg-pool 3.14.0
can settle Pool.end or a rejected Pool.query while the retired connection is
still closing. The first unmodified helper hit the single-connection gate in
five real tests. Waiting for actual retirement fixes those cases without
timers, private driver fields or a larger connection limit.

## Installed source binding

The [packaged test](../../test/pghybrid-adapters-packaged.pgvector.integration.test.ts)
packs the built runtime, installs it in a fresh locked app with the exact caller
dependencies, and copies the shipped compiled adapter/scenario and original
vendor files. Each of the five static entries is recorded and exactly replayed
by that same installed CLI. The four whole-cycle rows release four searches;
Postgres.js releases ten units, including actual type discovery and separate
description/execution. Its `unsafe` calls use the driver's default unprepared
path; these are not named prepared-query cache claims.

Source identity binds the selected files, license, actual installed dependency
bytes and built runtime. A changed installed pg source file is rejected before
the scenario imports again. The original app lock is unchanged. Every executed
setup journals its exact generated database name; an independent administrator
query requires all those names to be absent after cleanup.

The records pass. The installed run/replay workflow is qualified here;
`exportRegression` still requires a completed invariant violation. No failing
assertion is manufactured to turn these reads into a regression-export claim.

## Remaining lifecycle boundary

Postgres.js 3.4.9's default initial array-type query runs inside an internal
async function whose rejection is not caught when shutdown interrupts that
query. The first in-process cancellation/deadline tests emitted unhandled
`CONNECTION_DESTROYED` rejections from `fetchArrayTypes`.

The [contained file-worker tests](../../test/pghybrid-discovery-abort.pgvector.integration.test.ts)
retain this actual early-discovery case with defaults enabled. Both signal and
deadline produce **inconclusive**, zero released steps and an explicit worker
**exit 1** diagnostic; the parent survives and independently confirms the exact
owned database is absent. This proves containment, not successful in-process
driver shutdown. No global rejection suppression or vendor change is used.

The existing [Postgres.js protocol/lifecycle record](postgresjs-describe-flush-2026-09-09.md)
supplies its separate prepared, metadata, transaction-error/rollback and
in-flight shutdown evidence. Native pg has its separate whole-transaction retry
tests. The [Postgres.js transaction-conflict record](postgresjs-transaction-conflicts-2026-09-09.md)
qualifies deadlock handling and whole-transaction retry after serialization
failure separately; this adapter milestone does not itself test retries. The early
discovery limitation above remains explicit. These adapter checks do not cover arbitrary
Drizzle transaction objects, other Drizzle drivers, concurrent pool producers,
raw CancelRequest forwarding, HNSW application behavior, Python or other vector
and PostgreSQL profiles.


## Verification

The consolidated vector selection passed **30 tests in six files** on each
runtime: **36.17 seconds on Node 24.7.0** and **32.30 seconds on Node 22.18.0**.
Those totals include 20 new adapter/installed/containment checks and the ten
existing fixture/basic pghybrid checks. All five installed rows recorded and
exactly replayed on both runtimes. Each runtime's new ownership journal contains
50 distinct databases independently confirmed absent; both exact managed
containers were removed. No unhandled rejection escaped either final test run.

TypeScript checking and the production build passed. Another **88 tests in
three files** passed for pghybrid provenance, source identity and export source
binding. These measured durations are execution records, not comparative
performance results. They qualify this isolated change; the complete integrated
product matrix and canonical release archive have separate validation records.
