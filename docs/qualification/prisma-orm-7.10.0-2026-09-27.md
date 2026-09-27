# Prisma ORM 7.10.0 qualification — 27 September 2026

This local qualification covers **Prisma ORM 7.10.0** through
`@prisma/adapter-pg` 7.10.0 and node-postgres 8.23.0, installed as an ordinary
application beside an Interleave package archive. It ran the
[Prisma checkout example](../../examples/prisma/README.md) through its
[installed-consumer gate](../../scripts/test-prisma.mjs) on Node.js 22.18.0 and
24.7.0 against PostgreSQL 16, 17 and 18. The example is a constructed race, not a
historical Prisma defect.

## Inputs

| Input | Identity |
| --- | --- |
| Interleave source | Commit `418a970b2ea36a57b419a3ca2b0ea79d22d1013a` (branch `feature/prisma`, based on `2ee7677`) for the six-row matrix. Commit `000224dd03961c0082ca30144adfec6ddfda4c17` only enlarged the gate's search budgets; its confirmation runs are listed separately |
| Package archive | `pavangupta352-interleave-0.1.0-dev.0.tgz`, 1,856,498 bytes, SHA-256 `74cda8ab9a065d7ec57c919bc1c8b6a3f6300433dcde4c40f0783b7cff3138b9`, packed from a clean tree with Node.js 24.7.0 and npm 11.5.1. Both commits produce these exact bytes, because the gate files are not part of the package. Every run required this hash |
| Application lock | `@prisma/client` 7.10.0, `@prisma/adapter-pg` 7.10.0, `pg` 8.23.0; 23 locked packages, none with install scripts |
| Generator lock | `prisma` 7.10.0 and `typescript` 5.9.3; 137 locked packages. `prisma` and `@prisma/engines` declare install scripts, which the gate disables |
| Prisma engines | Engine hash `0edf323efd1d98336f3f0a68684b56f689b900d3`. On first use the CLI downloaded its darwin-arm64 schema engine (25,592,784 bytes) into the generator's `@prisma/engines` |
| Runtimes | Node.js 22.18.0 with npm 10.9.3; Node.js 24.7.0 with npm 11.5.1; macOS arm64 |
| Servers | Official Docker images `postgres:16` (`sha256:f1c3376c26f2…`, server 16.15), `postgres:17` (`sha256:67f41722b7a8…`, 17.11) and `postgres:18` (`sha256:4ef4dbc939d6…`, 18.6), one owned container per major |

## Results

Each row is a separate run of `npm run test:prisma` with a new evidence
directory, its own generated client and its own recordings. Two rows ran at a
time, alongside unrelated work on the same host.

| Node.js | PostgreSQL | Checks | Duration |
| --- | --- | --- | --- |
| 24.7.0 | 16.15 | 13 of 13 passed | 734 s |
| 24.7.0 | 17.11 | 13 of 13 passed | 952 s |
| 24.7.0 | 18.6 | 13 of 13 passed | 683 s |
| 22.18.0 | 16.15 | 13 of 13 passed | 687 s |
| 22.18.0 | 17.11 | 13 of 13 passed | 734 s |
| 22.18.0 | 18.6 | 13 of 13 passed | 956 s |

No check was skipped. The [example guide](../../examples/prisma/README.md#qualification-gate)
lists every check and its required observations. Values that were identical in
every row:

- **Generated client.** `prisma generate` wrote the same 10 files (145,771
  bytes) in every run. The recorded source included the four files the client
  loads at run time: `client.ts`, `enums.ts`, `internal/class.ts` and
  `internal/prismaNamespace.ts`. The other six are the browser entry point and
  modules reached only through `import type` or `export type`; Node.js does not
  load them for this client, and they are not recorded.
- **Source identity.** 82,478,406 bytes in 602 files, with 23 dependency
  packages. `@prisma/client` contributed 74,458,946 bytes in 75 files. The
  `prisma` and `typescript` optional peers were recorded as missing. All six runs
  recorded the same source identity fingerprint (`c1c74346…`), although npm
  10.9.3 and 11.5.1 performed the installations; fixture fingerprints differed
  only between PostgreSQL majors.
- **Unsafe checkout.** Ten release units: BEGIN and COMMIT as simple queries,
  parameterized SELECT, INSERT and UPDATE as extended cycles, with bob's UPDATE
  waiting on a `Lock` held by alice's backend. The invariant failed with
  `Accepted orders exceed the available stock`; CLI replay repeated the failure
  and every step fingerprint.
- **Library API.** `explore` found the violation in its first run. `replay`
  repeated it. `minimize` and the CLI both reduced 10 recorded choices to 0 in 5
  attempts (`locally-minimal`), because the fair fallback alone reproduces it.
- **Drift.** An appended comment in `internal/class.ts`, and separately a new
  `sku` field in the schema followed by regeneration (which changed
  `internal/class.ts` and `internal/prismaNamespace.ts`), each made exact replay
  `incompatible` (exit 3) with no import, setup or invariant call. Regenerating
  from the restored schema reproduced every recorded file byte for byte, and
  exact replay then repeated the violation.
- **Transactions.** Serializable purchases produced one real `40001` on bob's
  UPDATE, in transaction state E after alice's COMMIT; the retry passed with
  `retried: ['P2034']`, and without retry the run was `actor-error` with no
  invariant call. The order lifecycle produced `23505` in state E, ROLLBACK to I,
  and five further statements on the same connection without error.
- **Prepared statements.** Every command was a named extended cycle; each
  session's `pg_prepared_statements` held exactly one statement per distinct SQL
  text, and exact replay matched.
- **Searches.** The conditional-decrement repair exhausted its frontier after 47
  passing runs (65–132 s); the guided rerun of the unsafe recording against it
  was `incompatible` at step 5. After the checkout was switched to
  compare-and-set, the guided rerun passed and a fresh search exhausted its
  frontier after 363 passing runs, taking 542–810 s with median runs of 1.4–2.1 s
  and a slowest run of 12.7 s under the 30-second per-run deadline.
- **Export.** `interleave export --runtime-archive …` exited 2 with
  `Archive download exceeds 16 MiB` and created no directory.
- **Cleanup.** 432 generated databases per run; all were absent afterwards, with
  no remaining backends, and all 19 CLI command processes had exited.

The guided attempt that stopped at step 5 interrupted both actors mid-transaction.
Both Prisma operations settled as rejected (`Interleave actor proxy closed
before command completion`, surfaced by Prisma as database error `0A000`), and
cleanup was complete. This is the only interruption the gate exercises; it is
not a deadline or cancellation qualification.

### Confirmation at `000224d`

After the gate's search budgets were enlarged, the same archive passed the
committed gate again, two runs at a time on a host shared with other workloads:

| Node.js | PostgreSQL | Checks | Duration | 363-run search |
| --- | --- | --- | --- | --- |
| 24.7.0 | 17.11 | 13 of 13 passed | 1,314 s | 1,048 s; median run 2.4 s, slowest 18.4 s |
| 22.18.0 | 16.15 | 13 of 13 passed | 1,312 s | 1,047 s; median run 2.5 s, slowest 18.4 s |

Both runs recorded the same source identity fingerprint and generated client as
the matrix. The earlier 900-second search budget would not have covered either
search.

## Additional observations

- **Unchanged runtime.** With an archive built from `2ee7677`, whose source
  identity default was 64 MiB, the same unsafe checkout ran as `inconclusive`
  (exit 4) with `Source identity byte limit exceeded` and no SQL. Commit
  `5784193` raised the default to 128 MiB; that commit's unit test captures a
  75 MiB package graph and rejects a 135 MiB graph.
- **CLI installed beside the client.** In a copy of the example with
  `npm install -D prisma@7.10.0`, the package closure measured 310,499,758 bytes
  in 10,437 files and 158 packages, including the 25,592,784-byte schema engine.
  `interleave run` was `inconclusive` (exit 4) with `Source identity byte limit
  exceeded` before any SQL.
- **Explicit client archive.** Supplying the original
  `@prisma/client-7.10.0.tgz` (26,828,688 bytes) with `--dependency-archive`
  stops export with `File exceeds the 16777216 byte limit`.
- **Documented commands.** The example guide's final commands (30-second runs,
  2,700-second search), run literally with `npx` from a copy of the committed
  example and this archive, exited 1, 1, 1 for record, replay and minimization,
  then 3, 0, 0 for exact replay, guided rerun and the fresh search after the
  repair, on Node.js 24.7.0 with PostgreSQL 18.6 and on Node.js 22.18.0 with
  PostgreSQL 17.11. Both searches exhausted their frontier after 363 passing
  runs. Earlier attempts shaped those budgets. With the default 10-second run
  deadline, three searches stopped as `inconclusive` after 23 to 34 passing
  runs; the one retained as JSON failed with `Source identity could not be
  verified after execution: Source identity deadline exceeded` after 10,153 ms.
  With 30-second runs and a 900-second search, two searches stopped with
  `deadline` after 182 runs. All five ended with exit 4, and none is counted as
  a pass.
- **Unit suite at `000224d`.** 555 tests in 30 files passed on Node.js 22.18.0.
  On Node.js 24.7.0 the first attempt had one failure: a nested
  `scripts/test.mjs` start in `test/test-script.test.ts` exceeded that test's
  5-second limit (status 143) while two example runs loaded the host. A rerun
  passed all 555.
- **Integration suite at `000224d`.** On Node.js 24.7.0 against the owned
  PostgreSQL 16.15 server, 288 of 289 tests passed. The CLI test "runs, records,
  exactly replays and minimizes a real violation, including output paths with
  spaces" reached its 20-second test timeout under host load; that file then
  passed 11 of 11 when rerun alone.

## Limits

This record covers the stated example, versions and host only. It does not
qualify portable export for Prisma 7.10.0, Prisma 8, other adapters or drivers,
Accelerate or Prisma Postgres, relation queries, nested writes, deadlock
handling, `prisma migrate` against the test server, cancellation and deadlines,
other operating systems, or exact replay across Node.js or PostgreSQL versions.
An exhausted frontier describes the schedules Interleave's search modeled, not
every possible execution.
