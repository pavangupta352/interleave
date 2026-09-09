# Concepts

Interleave tests concurrent application operations against real PostgreSQL.
It delays the release of commands from those operations to explore orders that
ordinary tests may rarely encounter. Your database driver sends its real queries,
and PostgreSQL executes them.

## A scenario describes a business rule

A **scenario** is an object with `name`, `setup`, `actors` and `invariant`.
For the CLI, default-export it from a module; `defineScenario(...)` is an optional
helper that provides type checking. **Setup** creates the schema and starting rows in a fresh database.
An **actor** is one named concurrent operation, such as Alice buying the last item.
The **invariant** is an assertion about the application's required behavior after
the operations finish, such as "accepted purchases never exceed capacity."

Setup and the invariant use a direct database connection. Each of the two to
eight actors gets its own proxy connection URL. The actor must use that URL for
the application queries under test. A pool created elsewhere with the original
URL bypasses scheduling.

Each execution repeats setup in a separate generated database. A search can
therefore run the same scenario many times without reusing its previous rows.
With `--docker`, one owned server lasts for that command; Interleave still creates
and removes a database for each execution inside it.

## A plan chooses which command to release next

Consider two operations that each read zero, add one in JavaScript, and write
the answer. The plan `alice,bob,alice,bob` can produce:

| Release | Actor | Command | Observation |
| ---: | --- | --- | --- |
| 1 | alice | Read counter | 0 |
| 2 | bob | Read counter | 0 |
| 3 | alice | Write counter | 1 |
| 4 | bob | Write counter | 1 |

The final value is one even though both operations completed. An invariant
requiring two detects the lost update.

A **plan** is a prefix of actor choices. After its explicit choices end, the
runner rotates fairly among actors that can proceed. An **exploration** tries
alternative prefixes from observed choices until it finds a failure, exhausts
its modeled frontier, or reaches a configured limit. FIFO is the default search
order. A seed makes pending-prefix selection repeatable when the observed choices
match; it does not control external inputs or database execution.

## Release and completion are different events

A **release** lets a protocol unit pass through the proxy. A **completion** is
the PostgreSQL response to it. PostgreSQL owns execution, locks, deadlock victim
selection, and resumption after a lock is released. Interleave records actual
observed waits; a missing wait observation does not establish that no wait occurred.

The default protocol releases an entire Simple Query packet or an extended
query cycle through Sync. A packet containing several SQL statements is one
unit, and a server-side function stays opaque. Postgres.js's explicit
`describe-flush-v1` profile can release metadata and execution separately.
A report row therefore represents a release unit rather than necessarily one
SQL statement or one affected row.

## A result describes what was observed

| Outcome | Meaning | Next step |
| --- | --- | --- |
| `passed` | The completed run satisfied the invariant | Check the overall search stop reason and limits |
| `violation` | An assertion in the invariant failed | Retain the artifact and reproduce the failure |
| `actor-error` | An application operation rejected | Inspect its error and decide whether the scenario models expected errors correctly |
| `incompatible` | The requested replay or profile contract did not match | Inspect the reason; use guided execution only when you intend new evidence |
| `inconclusive` | Execution could not finish within the supported limits | Inspect the reason and partial evidence |
| `harness-error` | Setup, invariant execution, or harness work failed | Inspect the error and cleanup status |

An assertion failure in the invariant is a violation. A different invariant
exception is a harness error. An expected application rejection should be
handled by the application/scenario and represented as a result when that is
part of the behavior under test.

Run outcomes and command exit codes are related but distinct. For example,
a search may retain a passed run and still exit 4 because more prefixes remain
after its run budget. Incomplete cleanup takes precedence over a successful
observation. See the [exit table](cli.md#limits-and-machine-output).

## Exact replay retains a contract; guided runs create new evidence

An **artifact** is the validated JSON record of one run. It contains command and
completion evidence, selected actor observations, the invariant outcome,
cleanup, and captured identities. `--json` on `run` instead prints a search summary;
use `--out` to retain a replay artifact.

A **fixture identity** fingerprints the captured starting database. A file
record also identifies selected source files, installed dependencies, the
Interleave runtime, and actor connection startup. Exact replay checks those
inputs and the recorded command/wait contract while observing results again.
It does not force row counts, return values, errors, or the invariant outcome
to equal the original run.

Editing application source makes an old file-bound artifact incompatible with
exact replay, even if the SQL happens to stay the same. A **guided run** uses
the old actor order against the current code and records a new identity. It
allows changed source, but the requested order must still be feasible and fully
consumed. An operation that now issues fewer commands can therefore remain
incompatible in guided mode. After a repair, use guided execution when that order
still applies and fresh exploration to check the changed behavior. Keep the
original failing source if you need to reproduce it exactly.

**Minimization** deletes explicit actor choices while preserving the original
invariant failure fingerprint. It does not remove application SQL. Zero remaining
choices means the failure occurs under the runner's fallback schedule; its SQL
commands still execute. Local minimality applies to those deletions under that
fallback policy.

A **regression export** retains the original failure, selected source, lockfile,
and matching runtime for replay elsewhere. Byte verification and a successful
clean installation/replay are separate checks. See the [CI guide](ci.md) for
checking repaired code and the [export guide](regressions.md) for retaining the
original case.

Clocks, randomness, external services, undeclared files, and PostgreSQL's internal
execution remain outside scheduling control. A passing bounded search describes
the executions observed; it does not prove that an application is race-free.
