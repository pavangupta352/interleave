# Postgres.js: describe, then execute

This deliberately unsafe counter uses unchanged Postgres.js 3.4.9 tagged
templates. Both actors read zero, then each writes one. The invariant requires
both increments to remain.

Postgres.js asks PostgreSQL to describe a parameterized statement before sending
its values. Select `describe-flush-v1` to record two separate release gates:
the real Parse/Describe/Flush prefix, then the real Bind/Execute/Sync continuation.
The description contains actual PostgreSQL metadata; only the later execution
fingerprint includes the parameter values. Cached prepared queries can use a
single complete-cycle release.

In an application with Interleave installed, copy `scenario.mjs`, then run:

```sh
npm install --save-exact postgres@3.4.9
interleave run scenario.mjs --protocol-profile describe-flush-v1 --max-runs 1 --out failure.json
interleave replay scenario.mjs failure.json --out replay.json
interleave report failure.json --out evidence.html
```

Set `TEST_DATABASE_URL` to a dedicated PostgreSQL administrator database first.
A violation exits 1. Replay inherits the recorded profile; it does not need the
flag again. Source identity binds the scenario, installed driver, and selected
Interleave runtime. The fixture is recreated in a fresh owned database for each
execution.

Each actor uses one connection and closes it in `finally`. Its abort listener
also closes the driver immediately when a run stops. Keep that listener when
using `sql.begin`: Postgres.js waits for ReadyForQuery before handling a server
error, and interrupted work must not wait for a protocol boundary that will
never arrive. Interleave does not synthesize that boundary or execute rollback
on the application's behalf.

`fetch_types: false` avoids Postgres.js's initial custom-type discovery query in
this small example. Type discovery is also covered by the driver qualification
tests. The example is a constructed race, not a historical Postgres.js defect.
Passing explored schedules does not establish race freedom.

Portable exports retain this staged artifact and the original installed npm
graph. See [regression exports](../../docs/regressions.md) for archive inputs,
offline installation, and exact replay.
