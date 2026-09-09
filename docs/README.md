# Interleave documentation

Start with the task you want to complete. Interleave is under development and
has no stable release yet; the setup guide covers the current source and local
package routes.

| I want to… | Read |
| --- | --- |
| Run a real example and open its report | [Getting started](getting-started.md) |
| Understand actors, invariants, plans, and replay | [Concepts](concepts.md) |
| Test an operation from my application | [Application guide](application-guide.md) |
| Keep a failure, check a repair, and run in CI | [Regression checks and CI](ci.md) |
| Find a command, flag, output, or exit code | [CLI reference](cli.md) |
| Call Interleave from JavaScript | [API reference](api.md) |
| Inspect SQL, results, and observed waits | [Offline reports](reports.md) |
| Package the original failing source for another checkout | [Regression exports](regressions.md) |
| Check driver, PostgreSQL, and extension support | [Compatibility](compatibility.md) |
| Diagnose a stopped run or ask for help | [Troubleshooting](troubleshooting.md) |

## Examples

| Example | What it teaches | Required profile |
| --- | --- | --- |
| [Application counter](../examples/application/README.md) | Import a business operation through an injected pg Client | Native PostgreSQL, node-postgres |
| [neveroversell](../examples/neveroversell/README.md) | Exercise the original unsafe purchase and safe reservation APIs | Native PostgreSQL, node-postgres Pool |
| [Postgres.js](../examples/postgresjs/README.md) | Parameterized tagged templates and interrupted-client shutdown | `describe-flush-v1`, Postgres.js 3.4.9 |
| [pghybrid](../examples/pghybrid/README.md) | The pinned library's four public search adapters | PostgreSQL 17, pgvector 0.8.6, stated caller versions |

The counter and neveroversell are constructed race examples. pghybrid is a
compatibility workload, with no claimed library defect. Each example's guide
states its tested boundaries; using one adapter does not qualify every feature
of its underlying driver or ORM.

## Maintainer references

See [contributing](../CONTRIBUTING.md), [architecture](architecture/specification.md),
[validation records](validation.md), the [implementation checklist](plans/implementation.md),
and [release preparation](releasing.md). Dated qualification records apply to
their named source and archive. They are not automatically evidence for a later
checkout or a stable release.

For reproducible problems, [open an issue](https://github.com/pavangupta352/interleave/issues/new?template=bug_report.md).
Use the [private security route](../SECURITY.md) for vulnerabilities.
