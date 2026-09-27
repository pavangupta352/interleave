# Python actors with psycopg

Two customers try to buy the last unit of a product. Each actor is an ordinary
Python program (`checkout.py`) using [psycopg 3](https://www.psycopg.org/psycopg3/);
Interleave starts it with `processActor` and gives it its own loopback PostgreSQL
endpoint in `DATABASE_URL` and the standard `PG*` variables. The program needs no
Interleave import and no test hooks.

`checkout.py` reads the stock and then decrements it in a separate statement, so
two purchases can both see `stock = 1`. `checkout_safe.py` makes one conditional
`UPDATE ... WHERE stock > 0` decide the purchase.

## Run it

You need Node.js 22.18+, Python 3 and a PostgreSQL route (`--docker`, or a
dedicated test server in `TEST_DATABASE_URL`). Copy this folder into an
application where Interleave is [installed](../../docs/getting-started.md#install-a-release),
as `python/` next to its `package.json`. Run everything from the application
root, because `--include` paths are relative to that project root:

```sh
python3 -m venv python/.venv && python/.venv/bin/pip install -r python/requirements.txt
export INTERLEAVE_PYTHON=python/.venv/bin/python

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run python/scenario.mjs --include python/checkout.py --docker --out oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay python/scenario.mjs oversell.json --docker

# The repaired program passes every explored order (exit 0). The search starts
# two Python processes for each of its 47 schedules, which can take longer than
# the default 60-second search budget, so give it ten minutes.
npx --no-install interleave run python/safe-scenario.mjs --include python/checkout_safe.py --docker --total-timeout-ms 600000
```

`--include python/checkout.py` binds the Python source into the recording: after
you edit it, exact replay reports `incompatible` instead of silently replaying
different code. The interpreter and installed Python packages are not part of Interleave's
identity; keep them pinned (this example pins `requirements.txt`) and replay in
the same environment.

## What was verified

An installed-package workflow ran with psycopg 3.3.6 (binary, libpq 18) on
Python 3.14 against PostgreSQL 16. The unsafe program oversold (two orders for
one unit), exact replay reproduced the same invariant failure, editing
`checkout.py` made exact replay incompatible, and exploring the safe program
exhausted its 47-schedule frontier with no violation under a ten-minute search
budget. CI repeats the workflow; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
