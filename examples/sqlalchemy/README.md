# Python actors with SQLAlchemy

Two customers try to buy the last unit of a product. Each actor is an ordinary
Python program using the [SQLAlchemy](https://www.sqlalchemy.org/) 2.1 ORM over
psycopg 3. Interleave starts it with `processActor` and gives it its own loopback
PostgreSQL endpoint in `DATABASE_URL` and the standard `PG*` variables; the
program needs no Interleave import and no test hooks.

`checkout.py` loads the product in a transaction, decides from the stock it read
and lets the session flush the decremented stock and the order at commit. Two
transactions that both read `stock = 1` both sell it: the second `UPDATE` waits
for the first transaction's row lock, then overwrites the same value.
`checkout_safe.py` loads the product with `with_for_update=True`, so the second
transaction waits at its `SELECT ... FOR UPDATE` and then reads the stock the
first one left. `models.py` holds the two mapped classes and the engine both
programs use.

## Run it

You need Node.js 22.18+, Python 3.11+ and a PostgreSQL route (`--docker`, or a
dedicated test server in `TEST_DATABASE_URL`). Copy this folder into an
application where Interleave is [installed](../../docs/getting-started.md#install-a-release),
as `sqlalchemy/` next to its `package.json`, and run everything from the
application root:

```sh
python3 -m venv sqlalchemy/.venv && sqlalchemy/.venv/bin/pip install -r sqlalchemy/requirements.txt
export INTERLEAVE_PYTHON=sqlalchemy/.venv/bin/python

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run sqlalchemy/scenario.mjs --include sqlalchemy/checkout.py --include sqlalchemy/models.py --docker --out sqlalchemy-oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay sqlalchemy/scenario.mjs sqlalchemy-oversell.json --docker

# Search 200 orders of the repaired program (exit 4: the run budget, not a
# violation, ended the search; the summary reports violations: 0).
npx --no-install interleave run sqlalchemy/safe-scenario.mjs --include sqlalchemy/checkout_safe.py --include sqlalchemy/models.py \
  --docker --seed 1 --max-runs 200 --total-timeout-ms 1200000
```

SQLAlchemy sends nine setup commands on each new connection before the
transaction (the server version, schema, isolation level and
`standard_conforming_strings`, a type lookup inside a savepoint, and the
surrounding `BEGIN` and `ROLLBACK`). Interleave schedules them like any other
commands, so two actors have far too many orders to explore them all. The
repair is checked with a bounded, repeatable seeded search instead. Its first
order alternates the two customers, as the order that oversold the unsafe
program did; there, the second `SELECT ... FOR UPDATE` waits for the first
transaction's row lock, and that customer buys nothing.

The `--include` paths bind the Python source into the recording: after you edit
either file, exact replay reports `incompatible` instead of silently replaying
different code. Include files rather than the folder: Python writes bytecode
into `__pycache__` while the actors run, and a changed included folder makes the
run `inconclusive`. The interpreter and installed packages are not part of
Interleave's identity; keep them pinned (`requirements.txt` pins SQLAlchemy and
psycopg) and replay in the same environment.

## What was verified

An installed-package workflow ran with SQLAlchemy 2.1.4 and psycopg 3.3.6 on
Python 3.14 against PostgreSQL 16. The unsafe program oversold on the search's
first order (the second `UPDATE` waited for the first transaction's row lock),
exact replay repeated the failure, so did a copy of the application in another
directory, and editing `checkout.py` made exact replay incompatible. The
repaired program's seeded search ran 200 orders with no violation and stopped
at its run budget with 752 prefixes unexplored. CI repeats the workflow; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
