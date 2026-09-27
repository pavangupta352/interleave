# Go actors with pgx

Two customers try to buy the last unit of a product. Each actor is an ordinary
Go program (`checkout`) using [pgx v5](https://github.com/jackc/pgx) with its
default settings; Interleave starts it with `processActor` and gives it its own
loopback PostgreSQL endpoint in `DATABASE_URL` and the standard `PG*` variables.
The program needs no Interleave import and no test hooks.

`checkout` reads the stock and then decrements it in a separate statement, so
two purchases can both see `stock = 1`. `checkout-safe` makes one conditional
`UPDATE ... WHERE stock > 0 RETURNING stock` decide the purchase and inserts the
order in the same transaction.

## Run it

You need Node.js 22.18+, Go 1.25 or later (the minimum in `go.mod`), and a
PostgreSQL route (`--docker`, or a dedicated test server in `TEST_DATABASE_URL`).
Copy this folder into an application where Interleave is
[installed](../../docs/getting-started.md#install-a-release), as `go/` next to its
`package.json`. Run everything from the application root, because `--include`
paths are relative to that project root:

```sh
# Build both programs into go/bin with the modules pinned by go.mod and go.sum.
go build -C go -o bin/ ./...

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run go/scenario.mjs --include go/checkout/main.go --docker --out oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay go/scenario.mjs oversell.json --docker

# The repaired program passes every explored order (exit 0). Its frontier has
# 295 schedules, more than the default 100 runs, and each schedule starts two
# processes, so raise the run limit and give the search half an hour.
npx --no-install interleave run go/safe-scenario.mjs --include go/checkout-safe/main.go --docker --max-runs 1000 --total-timeout-ms 1800000
```

The scenarios run the programs built in `go/bin`; set `INTERLEAVE_GO` to another
directory that holds `checkout` and `checkout-safe` builds.

`--include go/checkout/main.go` binds the Go source into the recording: after you
edit it, exact replay reports `incompatible` instead of silently replaying
different code. Rebuild after editing. The Go toolchain, the compiled programs
and the modules are not part of Interleave's identity; keep them pinned (`go.mod`
and `go.sum` pin pgx 5.11.0) and replay in the same environment.

## What pgx sends

pgx's default `QueryExecModeCacheStatement` prepares each new statement once per
connection as a named prepared statement. Interleave schedules the prepare cycle
(Parse, Describe and Sync), which executes nothing and completes without a
command tag, and each execution cycle (Bind through Sync) as separate steps.
`Begin` and `Commit` send simple queries. These programs' connections send only
`user` and `database` at startup, so a recording does not depend on the
application's directory.

## What was verified

On macOS (arm64) with PostgreSQL 16 and Node.js 24.7.0, using Go 1.27.1 and pgx
5.11.0, an installed-package run of these commands found the oversell (exit 1),
replayed it exactly (exit 1), replayed the same failure from a copy of the
application in another directory (exit 1), reported `incompatible` after
`checkout/main.go` changed (exit 3), and explored all 295 schedules of the
repaired program with no violation (exit 0). The `go` CI job repeats the
workflow on Ubuntu; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
