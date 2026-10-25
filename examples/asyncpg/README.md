# Python actors with asyncpg

Two customers try to buy the last unit of a product. Each actor is an ordinary
Python program using [asyncpg](https://github.com/MagicStack/asyncpg) 0.32.0.
Interleave starts it with `processActor` and gives it its own loopback
PostgreSQL endpoint in `DATABASE_URL` and the standard `PG*` variables; the
program needs no Interleave import and no test hooks.

`checkout.py` reads the stock and then writes the decremented value in a separate
statement, so two purchases can both see `stock = 1`. `checkout_safe.py` makes one
conditional `UPDATE ... WHERE stock > 0` decide the purchase.

asyncpg prepares every statement with Parse, Describe and Flush, waits for
PostgreSQL's answer, and then binds and executes it with Sync, and `fetchval`
executes with a row limit. Run it with `--protocol-profile flush-stages-v1`,
which releases the prepare and the execution as separate steps. The default
profile stops the run with an explicit unsupported-profile reason (exit 4), and
`describe-flush-v1`, written for Postgres.js, refuses the row limit.

## Run it

You need Node.js 22.18+, Python 3.9+ and a PostgreSQL route (`--docker`, or a
dedicated test server in `TEST_DATABASE_URL`). Copy this folder into an
application where Interleave is [installed](../../docs/getting-started.md#install-a-release),
as `asyncpg/` next to its `package.json`, and run everything from the application
root:

```sh
python3 -m venv asyncpg/.venv && asyncpg/.venv/bin/pip install -r asyncpg/requirements.txt
export INTERLEAVE_PYTHON=asyncpg/.venv/bin/python

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run asyncpg/scenario.mjs --include asyncpg/checkout.py \
  --protocol-profile flush-stages-v1 --docker --out oversell.json

# Replay the same order against the same source (exit 1 again). Replay uses the
# recorded protocol profile.
npx --no-install interleave replay asyncpg/scenario.mjs oversell.json --docker

# The repaired program passes every explored order (exit 0). Its 295 schedules
# exceed the default 100-run budget, and each starts two Python processes, so
# raise the run budget and give the search twenty minutes.
npx --no-install interleave run asyncpg/safe-scenario.mjs --include asyncpg/checkout_safe.py \
  --protocol-profile flush-stages-v1 --docker --max-runs 5000 --total-timeout-ms 1200000
```

`--include asyncpg/checkout.py` binds the Python source into the recording: after
you edit it, exact replay reports `incompatible` instead of silently replaying
different code. The interpreter and installed packages are not part of
Interleave's identity; keep them pinned (`requirements.txt` pins asyncpg) and
replay in the same environment.

## What was verified

An installed-package workflow ran with asyncpg 0.32.0 on Python 3.14 against
PostgreSQL 16. The unsafe program oversold (two orders for one unit), exact
replay repeated the failure, so did a copy of the application in another
directory, editing `checkout.py` made exact replay incompatible, and exploring
the repaired program exhausted its 295-schedule frontier with no violation. Each
statement was two steps in the record: its prepare and its execution. CI
repeats the workflow; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
