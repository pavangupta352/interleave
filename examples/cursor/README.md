# A batch job that reads through a cursor

A nightly interest job streams every account through a
[pg-cursor](https://www.npmjs.com/package/pg-cursor), two rows per batch, and
writes each new balance through a second connection from the same `pg.Pool`. A
customer deposits 50 into account 3 while it runs.

`applyInterest` in `jobs.mjs` writes `balance = <the balance the cursor read> *
1.1`. A cursor reads from the snapshot its query started with, so when the deposit
commits after the cursor opens and before the job reaches account 3, the job
writes back a balance that no longer includes the deposit, and the deposit is lost.
`applyInterestAtomically` computes `balance * 1.1` from the row as it is when the
update runs. Interest of 10% on 100 plus the deposit of 50 should leave 160.00 or
165.00 in account 3; the invariant fails below that.

The default profiles cannot schedule this job. It holds two connections at once,
which needs the `multi-producer-v1` connection profile, and the cursor waits on
Flush between batches, which needs the `flush-stages-v1` protocol profile. With
both, each batch is its own release and the deposit can run between batches; see
[cursors and Flush stages](../../docs/compatibility.md#cursors-and-flush-stages).

## Run it

Copy this folder into an application where Interleave, `pg` and `pg-cursor` are
[installed](../../docs/getting-started.md#install-a-release)
(`npm install --save-dev --save-exact pg-cursor@2.22.1`), as `cursor/` next to its
`package.json`, and run from the application root:

```sh
# The default profiles refuse the job's second connection, then its cursor batches.
# Each run stops inconclusive (exit 4) with a reason that names the profile to select.
npx --no-install interleave run cursor/scenario.mjs --docker
npx --no-install interleave run cursor/scenario.mjs --connection-profile multi-producer-v1 --docker

# Release each batch and each connection separately: the job loses the deposit (exit 1).
npx --no-install interleave run cursor/scenario.mjs --protocol-profile flush-stages-v1 --connection-profile multi-producer-v1 --docker --out cursor-failure.json

# Replay repeats the failure (exit 1); minimize keeps the choices it needs (exit 1).
npx --no-install interleave replay cursor/scenario.mjs cursor-failure.json --docker
npx --no-install interleave minimize cursor/scenario.mjs cursor-failure.json --docker --out cursor-reduced.json
npx --no-install interleave report cursor-failure.json --out cursor-failure.html

# The atomic update passes every explored order (exit 0).
npx --no-install interleave run cursor/safe-scenario.mjs --protocol-profile flush-stages-v1 --connection-profile multi-producer-v1 --docker --total-timeout-ms 600000
```

Replay and minimize take both profiles from the recording. In the report, the
cursor's batches are **Flush stage** rows on `interest #0`, each with the rows it
returned and whether the portal was suspended; the writes run on `interest #1`,
and the cursor's cycle ends with a **Sync** row when it closes.

## What was verified

On 25 October 2026, with the package installed in an application and PostgreSQL
16.15, Node.js 24.7.0, node-postgres 8.23.0 and pg-cursor 2.22.1: both default
profiles stopped as described. With both profiles the second explored order lost
the deposit (account 3 at 110.00): the deposit committed right after the cursor
opened, and the job then wrote back the old balance. Exact replay repeated the
failure, reduction kept 1 of the recording's 10 ordering choices in 7 attempts,
and the atomic version passed all 19 explored orders.
`test/examples-cursor.integration.test.ts` repeats this workflow.
