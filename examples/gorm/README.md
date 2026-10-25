# Go actors with GORM

Two customers try to buy the last unit of a product. Each actor is a Go program
using [GORM](https://gorm.io/) 1.31 with its PostgreSQL driver, which runs on
pgx. Interleave starts it with `processActor` and gives it its own loopback
PostgreSQL endpoint in `DATABASE_URL` and the standard `PG*` variables; the
`shop` package maps the two tables and opens that endpoint. The programs need no
Interleave import and no test hooks.

`checkout` reads the product with `First`, then updates it with the stock it
computed from that read and creates an order, each in GORM's default short
transaction. Two purchases that both read `stock = 1` both sell it.
`checkout-safe` reads the product with `clause.Locking{Strength: "UPDATE"}`
inside `db.Transaction`, so the second purchase waits at its
`SELECT ... FOR UPDATE` for the first to commit and then reads the stock it left.

## Run it

You need Node.js 22.18+, Go 1.25 or later (the minimum in `go.mod`), and a
PostgreSQL route (`--docker`, or a dedicated test server in `TEST_DATABASE_URL`).
Copy this folder into an application where Interleave is
[installed](../../docs/getting-started.md#install-a-release), as `gorm/` next to
its `package.json`, and run everything from the application root:

```sh
# Build both programs into gorm/bin with the modules pinned by go.mod and go.sum.
go build -C gorm -o bin/ ./...

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run gorm/scenario.mjs --include gorm/checkout/main.go \
  --include gorm/shop/shop.go --docker --out oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay gorm/scenario.mjs oversell.json --docker

# Search 200 orders of the repaired program (exit 4: the run budget, not a
# violation, ended the search; the summary reports violations: 0).
npx --no-install interleave run gorm/safe-scenario.mjs --include gorm/checkout-safe/main.go \
  --include gorm/shop/shop.go --docker --seed 1 --max-runs 200 --total-timeout-ms 1800000
```

GORM's driver sends `-- ping` twice when it opens a connection, prepares each
statement in its own cycle before executing it, and wraps each write in `begin`
and `commit`, so each customer sends about twelve commands. Two actors then have
more orders than a search can finish, and the repair is checked with a bounded,
repeatable seeded search instead. Its first order alternates the two customers,
as the order that oversold the unsafe program did; there, the second
`SELECT ... FOR UPDATE` waits for the first transaction's row lock, and that
customer buys nothing.

The scenarios run the programs built in `gorm/bin`; set `INTERLEAVE_GO` to
another directory that holds `checkout` and `checkout-safe` builds.

The `--include` paths bind the Go source into the recording: after you edit
either file, exact replay reports `incompatible` instead of silently replaying
different code. Rebuild after editing. The Go toolchain, the compiled programs
and the modules are not part of Interleave's identity; keep them pinned (`go.mod`
and `go.sum`) and replay with the same builds.

## What was verified

An installed-package workflow ran with GORM 1.31.2 and its PostgreSQL driver
1.6.3 (pgx 5.10.0) on Go 1.27.1 against PostgreSQL 16. The unsafe program oversold
on the search's first order (the second `UPDATE` waited for the first
transaction's row lock), exact replay repeated the failure, so did a copy of the
application in another directory, and editing `checkout/main.go` made exact
replay incompatible. A first search of the repaired program ran 553 orders with
no violation before its memory budget for pending orders stopped it; the
documented seeded search runs 200. CI repeats the workflow; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
