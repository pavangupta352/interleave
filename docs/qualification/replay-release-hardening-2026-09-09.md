# Replay and cleanup hardening

Executed on 9 September 2026 against development commit `7170a17`, with
Node.js 24.7.0 and npm 11.5.1. This qualifies the integrated changes below;
stable release and public distribution checks remain open.

| Check | Observed result |
| --- | --- |
| Type checking and production build | Passed |
| Native unit and real-database suite | 754 tests in 56 files passed in 137.61 seconds |
| Native test server | PostgreSQL 16.13, node-postgres 8.23.0 |
| Separate pgvector selection | Ten tests in three files passed in 5.16 seconds |
| pgvector test server | Explicit PostgreSQL 17 / pgvector 0.8.6 profile |
| Disposable vector server cleanup | Harness removal followed by an independent absence check |

These are test-suite durations, not performance comparisons. The suite includes
installed exports and release preparation fixtures; its test count is not a count
of independent application bugs.

## Database creation uncertainty

The new regression cases execute a real `CREATE DATABASE`, then inject a lost
acknowledgement at the driver promise boundary. Both in-process and supervised
execution preserve the generated recovery name, report incomplete cleanup and
avoid dropping an unconfirmed name. Only test teardown, which knows the actual
creation succeeded, removes that exact database.

Additional injected driver errors cover connection failures, unknown statement
completion, fatal severity, a plain error with coincidental PostgreSQL fields,
and localized severity. These injections do not claim that PostgreSQL emitted
those responses during the test. Existing real collision and initialization
failure regressions separately verify confirmed rejection and confirmed ownership.

## Execution and export prerequisites

Direct and wrapper exact replay now share completed-evidence validation. Tests
make the outcome, cleanup or command evidence incomplete and prove rejection before
setup or scenario import. Completed legacy records missing connection or fixture
identities return `incompatible` before creating another database. Actual guided
runs still execute and produce new evidence.

Export creation and offline verification require those same identities and
completed evidence. Rehashed bundles with incomplete traces, missing identities
or invalid UTF-8 are rejected. Export-format fixtures use explicitly synthetic
metadata; actual installed replay tests record real database runs.

Runtime identity now includes the CLI helper modules used by exported replay.
Tests omit a helper from the package or change it after recording and verify that
export fails. Application rejections observed before interruption also survive as
an incomplete `harness-error`; cancellation-induced rejections remain inconclusive.

Each change had failing regression evidence before its repair. Independent reviews
covered the core changes, actor-failure behavior and exact-readiness integration.
The complete integrated suite above then passed. The broader PostgreSQL/Node and
browser CI records are linked from [compatibility](../compatibility.md).

## Distribution boundary

The suite also includes 68 release preparation checks covering immutable source,
two clean builds, original archive equality, package contents, installed public
entry points and child-process cancellation. The
[release preparation guide](../releasing.md) explains the separate canonical-archive
acceptance and publication steps. These results do not qualify a stable tag,
registry download, historical comparison or a future source revision.

## Follow-up and published matrix

Commit `4b589db` adds four release-output recovery regressions and clearer CI scope
wording. Late write, cancellation, final-verification and directory-replacement
failures preserve the partial output and identify it explicitly. The 72 release
checks passed locally in 15.02 seconds, with type checking and an independent
review of both repairs.

The [subsequent CI run](https://github.com/pavangupta352/interleave/actions/runs/34322912399)
qualified exact commit `4b589dbac81eeef7bdabf461b105dc9bb29113b6`: all six native
PostgreSQL/Node combinations passed 758 tests in 56 files, both vector jobs passed
ten tests in three files, and all six browser/viewport combinations passed their
12 legacy and eight staged checks. Each job reported removal of its owned test
server. The tag-only assets job was skipped, as expected for a main-branch push.
This source matrix is separate from canonical-package acceptance and publication.
