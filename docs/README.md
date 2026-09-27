# Interleave documentation

Start with the task you want to complete. The setup guide covers installing a
release and building from source. Interleave is at 0.1: before 1.0, a minor
release may change the API, CLI or artifact format, and the changelog records
each change.

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
| See how real library defects and their fixes behaved, compared with other methods | [Historical case studies](case-studies.md) |

## Examples

| Example | What it teaches | Required profile |
| --- | --- | --- |
| [Application counter](../examples/application/README.md) | Import a business operation through an injected pg Client | Native PostgreSQL, node-postgres |
| [neveroversell](../examples/neveroversell/README.md) | Exercise the original unsafe purchase and safe reservation APIs | Native PostgreSQL, node-postgres Pool |
| [Postgres.js](../examples/postgresjs/README.md) | Parameterized tagged templates and interrupted-client shutdown | `describe-flush-v1`, Postgres.js 3.4.9 |
| [pghybrid](../examples/pghybrid/README.md) | The pinned library's four public search adapters | PostgreSQL 17, pgvector 0.8.6, stated caller versions |
| [TypeORM](../examples/typeorm/README.md) | A per-actor DataSource helper, transactions and whole-transaction 40001 retry (TypeORM 1.1.1 and [0.3.31](../examples/typeorm-0.3/README.md)) | Native PostgreSQL, node-postgres 8.23.0, Node.js 22.18 |
| [Python actors](../examples/python/README.md) | Run programs in another language as actors with `processActor` | Native PostgreSQL, Python 3 with psycopg 3.3.6 |
| [Historical cases](../examples/historical/README.md) | Knex, node-pg-migrate and Sequelize defects before and after their upstream fixes, with baselines | Native PostgreSQL, node-postgres 8.23.0 through each library |

The counter and neveroversell are constructed race examples. pghybrid is a
compatibility workload, with no claimed library defect. The historical cases
are defects that were reported and fixed in the libraries' own repositories.
Each example's guide states its tested boundaries; using one adapter does not
qualify every feature of its underlying driver or ORM.

## Maintainer references

See [contributing](../CONTRIBUTING.md), [architecture](architecture/specification.md),
[validation records](validation.md), the [implementation checklist](plans/implementation.md),
and [release preparation](releasing.md). Dated qualification records apply to
their named source and archive. They are not automatically evidence for a later
checkout or a stable release.

For reproducible problems, [open an issue](https://github.com/pavangupta352/interleave/issues/new?template=bug_report.md).
Use the [private security route](../SECURITY.md) for vulnerabilities.
