# Sequelize findCreateFind inside PostgreSQL transactions

Upstream: [sequelize/sequelize#13482](https://github.com/sequelize/sequelize/pull/13482),
"fix(postgres): fix `findCreateFind` to work with postgres transactions",
merged 23 October 2021.

`Model.findCreateFind` looks up a row, creates it when the lookup finds nothing,
and if the insert hits a unique constraint, looks the row up again. Inside a
PostgreSQL transaction that recovery cannot work: the failed insert aborts the
transaction, and the second lookup fails with `25P02` ("current transaction is
aborted"). The pull request describes the fix as avoiding "the risk of failing
the transaction and rendering it unusable". When a transaction is supplied on
PostgreSQL, the insert now uses `ON CONFLICT DO NOTHING`; an insert that returns
no row raises `EmptyResultError`, which the method catches before looking the
row up again.

| Directory | Sequelize | Published | Relation to the fix |
| --- | --- | --- | --- |
| `before-fix/` | 6.7.0 | 9 October 2021 | `findCreateFind` and the PostgreSQL query result handling match the fix's parent commit [`0943339`](https://github.com/sequelize/sequelize/commit/094333910e105bbc363321eb7557a582363a8f6d) |
| `after-fix/` | 6.8.0 | 24 October 2021 | `lib/model.js` is byte-identical to the squash commit [`84421d7`](https://github.com/sequelize/sequelize/commit/84421d7d738176ee6d0de705c493b145b9488532) |

6.8.0 is the next release after the fix and contains a few other changes; none
changes the SQL this scenario sends. The recorded SQL for the two releases is
identical except for the `ON CONFLICT DO NOTHING` clause. Both directories use
node-postgres 8.23.0, passed to Sequelize through its `dialectModule` option.

## Scenario

`scenario.mjs` is identical in both directories.

- **Setup** creates `claims` with a unique `claim_key`.
- **Actors** `alice` and `bob` each create their own Sequelize instance on their
  Interleave URL, with a pool of one connection, and call
  `Claim.findCreateFind({ where: { claimKey: 'winner' }, transaction })` inside a
  managed `sequelize.transaction()` at PostgreSQL's default READ COMMITTED
  level. Each actor returns the claim it received, or the error name and
  SQLSTATE if the call failed; Sequelize has already rolled the transaction back
  by then.
- **Invariant**: both calls return the claim, exactly one of them created it,
  both return the same row, and exactly one row exists.

Sequelize opens two connections per actor, one after the other: a first
connection it uses to learn the server version, whose setup also runs its
session settings and a type lookup, then the pooled connection for the
transaction. Interleave records them as successive connection generations of
the same actor.

## Run it

From a built Interleave checkout, with `TEST_DATABASE_URL` set to a dedicated
administrator database (or `--docker` added to each execution command):

```sh
mkdir -p ../interleave-historical
cp -R examples/historical/sequelize-find-create-find ../interleave-historical/
case=../interleave-historical/sequelize-find-create-find
npm ci --prefix $case/before-fix
npm ci --prefix $case/after-fix

node dist/cli.js run $case/before-fix/scenario.mjs --timeout-ms 30000 --out sequelize.interleave.json
node dist/cli.js replay $case/before-fix/scenario.mjs sequelize.interleave.json --timeout-ms 30000
node dist/cli.js minimize $case/before-fix/scenario.mjs sequelize.interleave.json \
  --timeout-ms 30000 --out sequelize-reduced.interleave.json

node dist/cli.js replay $case/after-fix/scenario.mjs sequelize.interleave.json --guided --timeout-ms 30000
node dist/cli.js run $case/after-fix/scenario.mjs --keep-going --max-runs 100 \
  --total-timeout-ms 900000 --timeout-ms 30000
```

Expected: the first run finds a violation (exit 1). Both lookups return no row,
alice inserts, and bob's insert waits for alice's transaction. Interleave
records that wait from PostgreSQL's lock information, releases alice's
`COMMIT`, and bob's insert then fails with `23505`; its retry lookup fails with
`25P02` and bob's transaction rolls back. Exact replay repeats the same commands
and wait, and minimization reaches zero explicit choices.

The guided run of the same order against 6.8.0 passes: bob's insert waits the
same way, then inserts nothing, and the retry lookup finds alice's row.

To keep a portable regression of the 6.7.0 failure, use the separate
installation profile described in the
[historical cases guide](../README.md#keep-a-portable-regression). The offline
shared bundle currently fails for this case, because Sequelize's dependency
`wkx` pulls in `@types/node`.

## Baselines

```sh
node examples/historical/harness/baseline.mjs --scenario $case/before-fix/scenario.mjs \
  --mode ordinary --trials 100
node examples/historical/harness/baseline.mjs --scenario $case/before-fix/scenario.mjs \
  --mode barrier --barrier $case/barrier.mjs --trials 20
```

The barrier withholds each transaction's first lookup result until both
transactions have looked the claim up. The isolation specs in
[`isolation/`](isolation/) transcribe the transaction statements with the
bound insert value written as a literal. They list bob's path explicitly,
because the tester cannot run Sequelize's recovery logic.
