# Troubleshooting

Start with the command's exit code, reported outcome, reason and cleanup status.
A failed business invariant, an unsupported profile and an unfinished run need
different responses. The [concepts guide](concepts.md#a-result-describes-what-was-observed)
explains these outcomes; the [CLI reference](cli.md#limits-and-machine-output)
defines exit-code precedence.

## Check the environment first

In an installed application, with Docker running and no selected administrator URL:

```sh
unset TEST_DATABASE_URL
npx --no-install interleave doctor --docker --json > doctor.json
```

For a dedicated server, set its `TEST_DATABASE_URL` and omit `--docker`. From a
built source checkout, replace `npx --no-install interleave` with
`node dist/cli.js`. Doctor's JSON contains `environment.nodeVersion`,
`environment.serverVersion`, the fixture identity, actual command evidence and
cleanup. It checks two node-postgres parameterized queries; it cannot certify
an arbitrary driver, application schema or external service.

## Find the next action

| Symptom | Check | Next action |
| --- | --- | --- |
| `interleave` is not found | Are you in a built checkout or an installed application? | Use `node dist/cli.js` in the former, `npx --no-install interleave` in the latter. Follow [installation](getting-started.md) if the executable is absent. |
| The development version cannot be installed from npm | This guide does not promise a published release | Build and install the original local archive through [the complete package route](getting-started.md#install-this-development-build-into-an-application). |
| No database URL is selected | Was `--docker` omitted? | Use `--docker`, or supply a dedicated administrator URL. The CLI never chooses an existing local database implicitly. |
| `--docker` conflicts with a URL | Check `TEST_DATABASE_URL` and `--database-url` | Keep the URL route and remove `--docker`, or unset the variable and remove the URL flag before using Docker. |
| Docker cannot start or be reached | Check that the engine is running and your user can access it | Start/fix the engine, or use the dedicated-server route. The first image download can take time. |
| `--postgres-image` is rejected | Check `--docker` and the exact allowlisted image spelling | Choose one of the four names in [getting started](getting-started.md#let-interleave-manage-a-local-server), with a compatible fixture profile. |
| Connection, authentication or database-creation failure | Read the reason; check the dedicated server and account privileges | Correct the test endpoint/account. It must permit creation and removal of generated databases. Do not point a test at production to work around setup. |
| A second actor connection is unsupported | Check all pools, monitors and module-global clients | Use one command-producing connection per actor. A larger connection cap only permits queryless auxiliaries. |
| Unsupported protocol or extension | Read the named profile and [compatibility matrix](compatibility.md) | Use the documented qualified driver/profile. Selecting a profile does not enable arbitrary TLS, COPY, pipelines or extensions. |
| The run waits before an actor's next query | Check application promises, driver initialization and client shutdown | Make sure the operation can settle and the client uses the actor URL. A timeout alone is not a PostgreSQL lock observation. |
| Output already exists | Check the exact `--out` destination | Choose a new artifact/report path, or explicitly use `--force`. `init` and `export` never overwrite. |
| `--out` appears twice with `npm run race` | The scaffold script already names its output | Use `npm run race -- --docker --force`, or call the local executable directly with a new output name. |
| Exact replay is `incompatible` | Read the mismatch reason: source, dependency/runtime, fixture, Node/Postgres, startup, command or wait contract | Restore the recorded inputs for original replay. For intentional source changes, use a separately labeled guided run and fresh repair checks. |
| Guided replay finishes before consuming every requested choice | Compare the old plan with the repaired operation's command count | Guided mode allows changed source but still requires a feasible, fully consumed order. Use fresh exploration when a repair removes commands; do not count the incompatible attempt as a passing invariant. |
| A migration or data input is missing from an export | Check the recording's source includes | Record new evidence with the required `--include`. Export cannot add uncaptured inputs to an old identity. |
| A shared export needs an archive or rejects a repack | Compare the requested archive's original lock integrity | Supply the original `--runtime-archive` or `--dependency-archive`; do not rewrite the historical lock or recording. |
| A passing run is accompanied by exit 4 | Inspect the overall search/reduction `stopReason`, pending work and limits | Treat it as incomplete exploration/reduction. Adjust a justified limit and make a new run; an earlier passed run does not finish the search. |
| Reduction reaches zero choices | Inspect its retained trace and failure fingerprint | Zero explicit choices uses fair fallback. It does not remove all queries or prove a globally shortest failure. |

## Inspect incomplete cleanup

A run's `cleanup.complete` concerns owned execution databases and harness
resources. Managed Docker also checks its container removal before printing the
command result. A previously saved RunResult artifact does not become proof of
later container cleanup.

When cleanup is incomplete, preserve the exact generated database or owned
container name in the error and inspect that resource on the dedicated server
or Docker engine. Interleave will not claim ownership when a database-creation
acknowledgement is ambiguous, and it will not remove a container whose ownership
identity no longer matches. Do not use broad database/container deletion as a
recovery shortcut. Restore access, confirm the named resource's ownership, and
remove only the resource you have verified.

Execution deadlines and teardown have separate bounds, so cleanup may continue
after an execution timeout. On POSIX, worker supervision owns its process group;
Windows supervision owns the worker itself. Detached application processes and
external services remain the scenario's responsibility. Supervision runs trusted
code; it is not a security sandbox.

## Report a reproducible problem

[Open a bug report](https://github.com/pavangupta352/interleave/issues/new?template=bug_report.md)
with the Interleave, Node, PostgreSQL and driver versions; OS; command and exit
code; outcome/reason; cleanup status; and a small synthetic scenario. State whether
exact replay repeats the problem. Distinguish a failure you observed from a
compatibility feature you would like supported.

Review SQL, errors and selected actor observations before attaching JSON or HTML.
If an artifact contains private values, describe the facts and provide a synthetic
reproduction instead. Replacing text inside evidence changes its identity; do
not present edited evidence as an exact original replay record. Report security
vulnerabilities through [SECURITY.md](../SECURITY.md), not a public issue.
