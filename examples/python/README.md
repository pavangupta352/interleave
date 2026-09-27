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
application where Interleave is installed through the
[local-archive route](../../docs/getting-started.md#install-this-development-build-into-an-application),
then:

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export INTERLEAVE_PYTHON=.venv/bin/python

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run scenario.mjs --include checkout.py --docker --out oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay scenario.mjs oversell.json --docker

# The repaired program passes every explored order (exit 0).
npx --no-install interleave run safe-scenario.mjs --include checkout_safe.py --docker
```

`--include checkout.py` binds the Python source into the recording: after you edit
it, exact replay reports `incompatible` instead of silently replaying different
code. The interpreter and installed Python packages are not part of Interleave's
identity; keep them pinned (this example pins `requirements.txt`) and replay in
the same environment.

## What was verified

An installed-package workflow ran with psycopg 3.3.6 (binary, libpq 18) on
Python 3.14 against PostgreSQL 16. The unsafe program oversold (two orders for
one unit), exact replay reproduced the same invariant failure, editing
`checkout.py` made exact replay incompatible, and exploring the safe program
exhausted its frontier with no violation. CI repeats the workflow; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
