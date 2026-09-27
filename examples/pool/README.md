# A request handler that uses a connection pool

Each actor is one request handler with its own `pg.Pool` (`max: 2`). It adds two
items at once with `Promise.all`, so its two queries run on two connections at the
same time. `tasks.mjs` reads the counter and writes the incremented value in a
separate statement; `addOneAtomically` uses one `UPDATE ... SET value = value + 1`.
Two handlers add four items in total, so the invariant expects the counter at 4.

The default profile allows one command-producing connection per actor and rejects
this handler. The `multi-producer-v1` connection profile schedules each connection
as its own lane (`alice#0`, `alice#1`); see
[multi-connection actors](../../docs/api.md#multi-connection-actors).

## Run it

Copy this folder into an application where Interleave and `pg` are
[installed](../../docs/getting-started.md#install-a-release), as `pool/` next to
its `package.json`, and run from the application root:

```sh
# The default profile refuses the pool's second connection: exit 4, inconclusive,
# with a reason that names the profile to select.
npx --no-install interleave run pool/scenario.mjs --docker

# Schedule each connection as a lane: the handlers lose increments (exit 1).
npx --no-install interleave run pool/scenario.mjs --connection-profile multi-producer-v1 --docker --out pool-failure.json

# Replay binds each recorded connection to a live one and repeats the failure (exit 1).
npx --no-install interleave replay pool/scenario.mjs pool-failure.json --docker

# Keep only the ordering choices the failure needs (exit 1), then write a report.
npx --no-install interleave minimize pool/scenario.mjs pool-failure.json --docker --out pool-reduced.json
npx --no-install interleave report pool-failure.json --out pool-failure.html

# The atomic update passes every explored order (exit 0).
npx --no-install interleave run pool/safe-scenario.mjs --connection-profile multi-producer-v1 --docker --total-timeout-ms 600000
```

Replay and minimize take the connection profile from the recording. The report
labels each command with its connection, `alice #1`, and names the connection a
lock wait was blocked by.

## What was verified

On 27 September 2026, with the package installed in an application and
PostgreSQL 16.15, Node.js 24.7.0: the default profile stopped as described; with
the lane profile the first run lost increments across four connections
(`alice#0`, `alice#1`, `bob#0`, `bob#1`), three exact replays repeated the failure,
reduction removed all 8 explicit choices in 5 attempts, and the atomic version
passed all 41 explored schedules. `test/examples-pool-overlap.integration.test.ts`
repeats this workflow.
