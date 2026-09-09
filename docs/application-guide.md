# Test an application operation

This guide calls a real business function through an injected node-postgres Client.
The function deliberately contains a lost-update race: two callers can read the
same counter value and overwrite each other's increment. The example is small
so that the application boundary is visible; it is not a historical defect.

Start with the separate application created by
[the local-package installation route](getting-started.md#install-this-development-build-into-an-application).
Run the following commands from `interleave-race`, where Interleave and
`pg@8.23.0` are installed and `package-lock.json` exists. Keep the same Node
version and installed dependencies for record, replay and reduction.

## Copy the complete example

```sh
mkdir application
cp node_modules/@pavangupta352/interleave/examples/application/counter.mjs application/counter.mjs
cp node_modules/@pavangupta352/interleave/examples/application/scenario.mjs application/scenario.mjs
```

These commands create a new `application` directory without changing the scaffold.
The [packaged files](../examples/application/README.md) are the complete runnable
example. Its tree is:

```text
interleave-race/
├── package.json
├── package-lock.json
├── node_modules/
└── application/
    ├── counter.mjs
    └── scenario.mjs
```

`counter.mjs` contains the operation the application would call. Its database
client is an explicit argument:

```js
export async function incrementCounter(client, id) {
  const { rows } = await client.query('SELECT value FROM counters WHERE id = $1', [id]);
  const value = rows[0].value + 1;
  await client.query('UPDATE counters SET value = $1 WHERE id = $2', [value, id]);
  return value;
}
```

The scenario imports that function literally. Each actor creates its own Client
from the supplied `connectionString`, calls `incrementCounter(client, 1)`, and
closes the client in `finally`. Both `alice` and `bob` use the same operation.
The application function's queries run unchanged through their actor proxies.

Setup creates `counters` and inserts `(1, 0)`. The invariant checks that both
operations fulfilled and the final value is two. Each actor returns `{ value }`,
which becomes a selected observation in the artifact. Database result rows are
not automatically recorded as actor observations.

The scenario uses the public `@pavangupta352/interleave` package import from an
ordinary installed application. Run it through this installation. The source
capture profile rejects package self-reference aliases, so moving this scenario
under the Interleave repository's own package root is not an equivalent route.

## Record, inspect and replay

Use Docker, or remove `--docker` from these commands and supply the dedicated
server URL described in [getting started](getting-started.md#choose-your-postgresql-server).
The helper below checks an expected exit code and fails for any other result.
Keep these commands in the same shell:

```sh
expect_exit() {
  interleave_expected="$1"
  shift
  if "$@"; then interleave_actual=0; else interleave_actual=$?; fi
  if [ "$interleave_actual" -ne "$interleave_expected" ]; then
    printf 'Expected exit %s, got %s\n' "$interleave_expected" "$interleave_actual" >&2
    return 1
  fi
}
unset TEST_DATABASE_URL
expect_exit 1 npx --no-install interleave run application/scenario.mjs --docker \
  --plan alice,bob,alice,bob --max-runs 1 --out application-failure.json
npx --no-install interleave report application-failure.json --out application-failure.html
expect_exit 1 npx --no-install interleave replay application/scenario.mjs application-failure.json \
  --docker --out application-replay.json
expect_exit 1 npx --no-install interleave minimize application/scenario.mjs application-failure.json \
  --docker --out application-reduced.json
```

Run each command in order and stop if it fails. The plan releases Alice's read,
Bob's read, Alice's update, then Bob's update. The invariant should observe one
instead of two. Record, exact replay and completed reduction therefore exit 1.
An error or incomplete result must not be accepted as the expected violation.

Open `application-failure.html`. Compare the two reads and later writes, the
selected values returned by actors, the invariant message, and cleanup. Exact
replay checks the recorded inputs and command contract but observes the outcome
again; it does not guarantee that every application failure repeats.

Reduction preserves the original failure fingerprint while removing explicit
choices. It may reach zero choices while retaining four actual SQL releases
under the runner's fallback schedule. Inspect `stopReason` and any
`attemptFailure` before calling a reduction complete.

For machine output, add `--json` to a command. On `run`, stdout is an
ExplorationResult search summary, while `--out` writes one RunResult artifact.
Only the latter is accepted as the replay input. See [outcomes and exit codes](cli.md#limits-and-machine-output).

## Adapt your existing operation

Keep your business function and queries. Give the function an injected Client,
Pool, or connection-string argument so the scenario can supply the actor endpoint.
A module-global pool connected to another URL would bypass Interleave. Construct
one driver instance per actor; close it when the operation ends. With node-postgres
Pools, use `max: 1` for this profile.

An actor defaults to one admitted physical PostgreSQL connection. Increasing
`maxConnectionsPerActor` permits queryless auxiliary sessions, such as a monitor.
Only one live connection may produce commands; it keeps that role until it closes,
including while idle. A single actor cannot use a larger pool to run simultaneous
queries on different live connections. See the [connection contract](api.md#define-a-scenario).

The actor context also supplies an `AbortSignal`. Use the driver's public
shutdown/cancellation lifecycle when an operation can remain pending during
interruption. The [Postgres.js example](../examples/postgresjs/README.md) includes
its required abort listener; the [pghybrid caller helpers](../examples/pghybrid/README.md#additional-public-adapters)
show the qualified Pool/Kysely ownership paths. The simple Client example here
relies on `finally` plus supervised file execution; it does not claim to cover
those more complex callers.

Put schema creation, migrations and starting rows in `setup`. Every attempted
schedule gets a new database and reruns setup. Keep application inputs stable:
explicit IDs, fixed starting rows, and controlled responses from any external
services your operation calls. Interleave does not control wall-clock time,
randomness or those services.

Assert the business rule in `invariant`, rather than asserting one preferred
ordering. An expected application rejection can be caught and returned as a
meaningful value for the invariant to inspect. An unhandled rejection is an
`actor-error`; an assertion thrown by the invariant is a `violation`; another
invariant exception is a `harness-error`.

## Include migrations and fixture files when recording

Interleave follows literal module imports and captures the installed dependencies.
Other files read as data must be included explicitly. For example, if your own
scenario reads `migrations/` and `fixtures/initial.json`, the recording command is:

```sh
npx --no-install interleave run test/race.mjs --docker --project-root . \
  --include migrations --include fixtures/initial.json --out failure.json
```

This command is a template for an application with those files; they are not
part of the counter example. Include paths are relative to the chosen project
root. Replay and export inherit them. Adding an include at export time cannot
supply inputs missing from the original recording.

Literal imports must resolve under ordinary Node rules. Use explicit extensions
for ESM local imports. Computed imports, package `#` aliases, self-reference
aliases, symbolic links, application native addons and custom loaders are outside
this source profile. Includes capture selected data files; they do not attest
arbitrary runtime discovery or undeclared environment variables.

## Use compiled TypeScript

The installed CLI loads runnable ESM. It does not install tsx or honor an arbitrary
TypeScript loader. Compile your application and scenario first, keeping relative
imports correct in the emitted JavaScript, then give Interleave the emitted
scenario path. For a project whose existing build emits `dist/test/race.js`:

```sh
npm run build
npx --no-install interleave run dist/test/race.js --docker --project-root . \
  --include migrations --out typescript-failure.json
```

This is a template for that build layout, not a build configuration supplied by
Interleave. Keep `package.json`'s ESM scope, the emitted module graph, dependency
lock and data inputs available. Rebuilding changed files invalidates exact replay
of the old file identity, even if the emitted SQL remains the same. The original
source-runtime and built-runtime identities are also different.

Continue with [regression checks and CI](ci.md) to preserve the failure and test
an atomic repair. Use [regression exports](regressions.md) when another checkout
needs the original failing application and runtime.
