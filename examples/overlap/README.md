# Two workers claim the same job

Each actor is a worker that claims job 1 with one statement:

```sql
INSERT INTO claims (job_id, worker)
SELECT 1, $1 WHERE NOT EXISTS (SELECT 1 FROM claims WHERE job_id = 1)
```

Because the check and the insert are one statement, releasing the two workers'
statements one after the other can never produce two claims: the second always
sees the first. The race lives inside statement execution. Two statements that
start together take their snapshots before either commits, both see no claim, and
both insert. `claimOnce` in `claims.mjs` gives the table a primary key and uses
`ON CONFLICT (job_id) DO NOTHING`, so PostgreSQL makes the second worker wait and
then insert nothing.

By default Interleave releases one command at a time, so it cannot reach this
race. `--overlap pairs` adds choices that release two workers' next commands in
the same instant; see [statement overlap](../../docs/api.md#statement-overlap).

## Run it

Copy this folder into an application where Interleave and `pg` are
[installed](../../docs/getting-started.md#install-a-release), as `overlap/` next
to its `package.json`, and run from the application root:

```sh
# One statement at a time: every order passes (exit 0).
npx --no-install interleave run overlap/scenario.mjs --docker

# With overlap pairs, the search releases both claims together (exit 1).
npx --no-install interleave run overlap/scenario.mjs --overlap pairs --docker --out claim-failure.json

# Replay sends the pair together again (exit 1 when PostgreSQL interleaves it the same way).
npx --no-install interleave replay overlap/scenario.mjs claim-failure.json --docker

# The primary key and ON CONFLICT pass every sequential and paired choice (exit 0).
npx --no-install interleave run overlap/safe-scenario.mjs --overlap pairs --docker
```

PostgreSQL decides how two released statements interleave, and Interleave cannot
force it. A paired run can therefore pass when one statement happens to finish
before the other starts, and a replay can pass where the recording failed.
__RATES__

## What was verified

__VERIFIED__
