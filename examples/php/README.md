# PHP actors with PDO

Two customers try to buy the last unit of a product. Each actor is an ordinary
PHP program (`checkout.php`) using [PDO](https://www.php.net/manual/en/book.pdo.php)
with the `pdo_pgsql` driver and its default settings; Interleave starts it with
`processActor` and gives it its own loopback PostgreSQL endpoint in the standard
`PG*` variables. The program needs no Interleave import and no test hooks.

`checkout.php` reads the stock and then decrements it in a separate statement,
so two purchases can both see `stock = 1`. `checkout_safe.php` makes one
conditional `UPDATE ... WHERE stock > 0 RETURNING stock` decide the purchase and
inserts the order in the same transaction.

## Run it

You need Node.js 22.18+, PHP 8 with the `pdo_pgsql` extension, and a PostgreSQL
route (`--docker`, or a dedicated test server in `TEST_DATABASE_URL`). Copy this
folder into an application where Interleave is [installed](../../docs/getting-started.md#install-a-release),
as `php/` next to its `package.json`. Run everything from the application root,
because `--include` paths are relative to that project root:

```sh
# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run php/scenario.mjs --include php/checkout.php --docker --out oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay php/scenario.mjs oversell.json --docker

# The repaired program passes every explored order (exit 0). Its frontier has
# 619 schedules, beyond the default 100 runs and 64 MiB of retained results,
# and each schedule starts two PHP processes, so raise all three budgets.
npx --no-install interleave run php/safe-scenario.mjs --include php/checkout_safe.php --docker --max-runs 1000 --max-search-bytes 134217728 --total-timeout-ms 3600000
```

Set `INTERLEAVE_PHP` to run another PHP executable. The example needs no
Composer packages: PDO and `pdo_pgsql` ship with PHP. The programs build their
DSN from `PGHOST`, `PGPORT` and `PGDATABASE` with `sslmode=disable` and pass
`PGUSER` and `PGPASSWORD` to `PDO`.

`--include php/checkout.php` binds the PHP source into the recording: after you
edit it, exact replay reports `incompatible` instead of silently replaying
different code. PHP, its extensions and the libpq they load are not part of
Interleave's identity; keep them pinned and replay in the same environment.

## What PDO sends

PDO's default server-side prepared statements take three protocol cycles, and
Interleave schedules each one as its own step: the first `execute()` of a
prepared statement sends Parse in one cycle and Bind and Execute in the next,
and releasing the `PDOStatement` object sends Close. The Parse and Close steps
execute nothing; they complete without a command tag and are recorded with the
statement's text. (`pdo_pgsql` built against libpq older than 17 deallocates
with a `DEALLOCATE` simple query instead of Close; that build was not run here.)

Every step can interleave with the other actor, so where a program releases its
statements changes the search. `first_row` releases each statement as soon as
its row is read, so both Close steps happen inside the transaction. In an earlier version that kept both statements in
variables until the script ended, their Close steps came after `COMMIT`, and the
first 100 runs of the repaired checkout's search left 158 schedules pending.

## What was verified

On macOS (arm64) with PostgreSQL 16 and Node.js 24.7.0, using Homebrew PHP 8.5.0
(`pdo_pgsql` with libpq 18.1), an installed-package run of these commands found
the oversell (exit 1), replayed it exactly (exit 1), replayed the same failure
from a copy of the application in another directory (exit 1), reported
`incompatible` after `checkout.php` changed (exit 3), and explored all 619
schedules of the repaired program with no violation (exit 0). The `php` CI job
repeats the workflow on Ubuntu with the PHP 8.5 build that `setup-php`
installs; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
