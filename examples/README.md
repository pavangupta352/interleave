# Examples

Each example is a small application with a real race, the scenario that finds
it, and a repaired version that passes. Its README lists the commands to run from
an application where Interleave is installed, the exit code of each, and what was
verified.

## Start here

- [neveroversell](neveroversell/README.md): the built-in oversell demo behind
  `interleave demo`.
- [application](application/README.md): an operation that takes an injected
  database client, the pattern the [application guide](../docs/application-guide.md)
  describes.

## Drivers and ORMs

- [postgresjs](postgresjs/README.md): Postgres.js parameterized queries with the
  `describe-flush-v1` profile.
- [orm](orm/README.md): ordinary Drizzle and Kysely queries over node-postgres.
- [typeorm](typeorm/README.md) and [typeorm-0.3](typeorm-0.3/README.md): a
  per-actor DataSource helper with transactions and retry.
- [prisma](prisma/README.md): Prisma ORM 7 with `@prisma/adapter-pg`.
- [sequelize](sequelize/README.md), [knex](knex/README.md) and
  [mikro-orm](mikro-orm/README.md): per-actor helpers for each ORM.

## Other languages

Programs in other languages run as actors through `processActor`:
[python](python/README.md) (psycopg), [ruby](ruby/README.md) (pg gem),
[php](php/README.md) (PDO), [go](go/README.md) (pgx) and [java](java/README.md)
(pgjdbc). Python also has [asyncpg](asyncpg/README.md), with the
`flush-stages-v1` profile its prepared statements need, and the
[SQLAlchemy](sqlalchemy/README.md) and [Django](django/README.md) ORMs; Ruby has
[Active Record](activerecord/README.md) and Go has [GORM](gorm/README.md).

## Connections, overlap and cursors

- [pool](pool/README.md): a request handler whose `pg.Pool` uses two connections
  at once (`multi-producer-v1`).
- [overlap](overlap/README.md): two workers claim the same job in a single
  statement each (`--overlap pairs`).
- [cursor](cursor/README.md): a batch job that reads through pg-cursor and loses
  a concurrent deposit between batches (`flush-stages-v1`).

## Extensions and history

- [pghybrid](pghybrid/README.md): a pgvector hybrid search workload on PostgreSQL
  17 with pgvector 0.8.6.
- [historical](historical/README.md): three published bugs in Knex,
  node-pg-migrate and Sequelize, measured against ordinary concurrency, manual
  barriers and PostgreSQL's isolation tester.
