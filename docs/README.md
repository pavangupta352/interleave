# Interleave documentation

Start with the task you want to complete. The setup guide covers installing a
release and building from source. Interleave is at 0.3: before 1.0, a minor
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
| [Ruby actors](../examples/ruby/README.md) | A Ruby program using the pg gem as an actor, with a locked bundle | Native PostgreSQL, Ruby with pg 1.6.3 |
| [PHP actors](../examples/php/README.md) | A PHP program using PDO's server-side prepared statements as an actor | Native PostgreSQL, PHP 8 with `pdo_pgsql` |
| [Go actors](../examples/go/README.md) | A compiled Go program using pgx's statement cache as an actor | Native PostgreSQL, Go 1.25+ with pgx 5.11.0 |
| [Java actors](../examples/java/README.md) | A Java program using JDBC, run from source, as an actor | Native PostgreSQL, Java 21 with pgjdbc 42.7.13 |
| [Historical cases](../examples/historical/README.md) | Knex, node-pg-migrate and Sequelize defects before and after their upstream fixes, with baselines | Native PostgreSQL, node-postgres 8.23.0 through each library |
| [Prisma ORM](../examples/prisma/README.md) | A generated Prisma 7 client that oversells, its repairs, serializable retries and prepared statements | Native PostgreSQL, Prisma 7.10.0 with `@prisma/adapter-pg` |
| [Sequelize](../examples/sequelize/README.md), [Knex](../examples/knex/README.md), [MikroORM](../examples/mikro-orm/README.md) | Per-actor ORM helpers with transactions, retry and portable export | Native PostgreSQL, node-postgres 8.23.0 |
| [Pool](../examples/pool/README.md) and [overlap](../examples/overlap/README.md) | A pool using two connections at once, and two claims in one statement each | `multi-producer-v1`, `--overlap pairs` |
| [Cursor](../examples/cursor/README.md) | A batch job that reads through pg-cursor and loses a deposit between batches | `flush-stages-v1`, `multi-producer-v1` |
| [asyncpg](../examples/asyncpg/README.md), [SQLAlchemy](../examples/sqlalchemy/README.md), [Django](../examples/django/README.md) | Python's asyncio driver and two ORMs as actors | asyncpg with `flush-stages-v1`; psycopg 3 |
| [Active Record](../examples/activerecord/README.md), [GORM](../examples/gorm/README.md) | The Ruby and Go ORMs as actors, with seeded repair searches | pg gem 1.6.3; pgx 5.10.0 |

The counter, neveroversell and Prisma checkout are constructed race examples.
pghybrid is a compatibility workload, with no claimed library defect. The
historical cases are defects that were reported and fixed in the libraries' own
repositories. Each example's guide states its tested boundaries; using one
adapter does not qualify every feature of its underlying driver or ORM.

## Maintainer references

See [contributing](../CONTRIBUTING.md), [architecture](architecture/specification.md),
[validation records](validation.md), the [implementation checklist](plans/implementation.md),
and [release preparation](releasing.md). Dated qualification records apply to
their named source and archive. They are not automatically evidence for a later
checkout or a stable release.

For reproducible problems, [open an issue](https://github.com/pavangupta352/interleave/issues/new?template=bug_report.md).
Use the [private security route](../SECURITY.md) for vulnerabilities.
