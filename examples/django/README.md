# Python actors with the Django ORM

Two customers try to buy the last unit of a product. Each actor is a standalone
Python program using the [Django](https://www.djangoproject.com/) 6.1 ORM over
psycopg 3. Interleave starts it with `processActor` and gives it its own loopback
PostgreSQL endpoint in the standard `PG*` variables, which psycopg reads, so
`shop_settings.py` names only the database. The programs need no Interleave
import and no test hooks.

`checkout.py` reads the product, then saves the stock it computed from that read
and creates an order, each statement in Django's default autocommit mode. Two
purchases that both read `stock = 1` both sell it. `checkout_safe.py` reads the
product with `select_for_update()` inside `transaction.atomic()`, so the second
purchase waits for the first to commit and then reads the stock it left. The
`shop` app holds the two models, mapped to the scenario's `product` and `orders`
tables.

## Run it

You need Node.js 22.18+, Python 3.12+ and a PostgreSQL route (`--docker`, or a
dedicated test server in `TEST_DATABASE_URL`). Copy this folder into an
application where Interleave is [installed](../../docs/getting-started.md#install-a-release),
as `django/` next to its `package.json`, and run everything from the application
root:

```sh
python3 -m venv django/.venv && django/.venv/bin/pip install -r django/requirements.txt
export INTERLEAVE_PYTHON=django/.venv/bin/python

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run django/scenario.mjs --include django/checkout.py \
  --include django/shop_settings.py --include django/shop/__init__.py --include django/shop/models.py \
  --docker --out oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay django/scenario.mjs oversell.json --docker

# The repaired program passes every explored order (exit 0). Its 295 schedules
# exceed the default 100-run budget, and each starts two Python processes, so
# raise the run budget and give the search ten minutes.
npx --no-install interleave run django/safe-scenario.mjs --include django/checkout_safe.py \
  --include django/shop_settings.py --include django/shop/__init__.py --include django/shop/models.py \
  --docker --max-runs 5000 --total-timeout-ms 600000
```

The `--include` paths bind the Python source into the recording:
after you edit any of them, exact replay reports `incompatible` instead of
silently replaying different code. Include files rather than the `shop` folder:
Python writes bytecode into `shop/__pycache__` while the actors run, and a
changed included folder makes the run `inconclusive`. The interpreter and
installed packages are not part of Interleave's identity; keep them pinned
(`requirements.txt` pins Django and psycopg) and replay in the same environment.

## What was verified

An installed-package workflow ran with Django 6.1.2 and psycopg 3.3.6 on Python
3.14 against PostgreSQL 16. Each connection began with Django's
`SELECT set_config('TimeZone', 'UTC', false)`. The unsafe program oversold on
the search's first order, exact replay repeated the failure, so did a copy of
the application in another directory, and editing `checkout.py` made exact
replay incompatible. Exploring the repaired program exhausted its 295-schedule
frontier with no violation in about five minutes. CI repeats the workflow; see
the [compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
