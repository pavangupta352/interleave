# TypeORM 0.3 example variant

This directory pins TypeORM **0.3.31** and node-postgres **8.23.0** with its own `package-lock.json`, for applications that have not moved to TypeORM 1.x. TypeORM 0.3.31 was the newest 0.3 release (npm `legacy` tag) when this row was qualified. The directory contains no helper of its own. It reuses the unchanged actor helper and scenario module from [`../typeorm`](../typeorm/README.md). Place `connection.mjs` (and `scenario.mjs`, if you want the example behaviors) next to this `package.json` so that they resolve this installation's `typeorm` and `pg`.

TypeORM 0.3.31 declares Node `>=16.13.0`. Only Node 22.18.0 was qualified.

There is one API difference to note: a 0.3.x QueryRunner exposes its DataSource as `runner.connection`, while 1.x names it `runner.dataSource`. The helper and scenario use neither property. With a connection URL, TypeORM 0.3.31 sends the same two initialization queries as 1.1.1, `SELECT version()` and `SELECT * FROM current_schema()`, and they are scheduled like any other command.

Observed on 2026-09-27 on macOS arm64 with Node 22.18.0 / npm 10.9.3 and official Docker images. The functional gate used the Interleave 0.1.0-dev.0 archive built from commit 3785d49; the lifecycle job used this checkout's own build. Both jobs ran the same assertions as for TypeORM 1.1.1:

| Job | PostgreSQL 16.15 | PostgreSQL 17.11 | PostgreSQL 18.6 |
| --- | --- | --- | --- |
| Functional gate: 11 cases, including minimization, helper drift and portable export/replay | 11/11 | 11/11 | 11/11 |
| Lifecycle job: 14 cancellation, acquisition and cleanup checks | 14/14 | 14/14 | 14/14 |

Each row recorded, replayed and exported against its own server. There is no cross-version exact replay.

Run either job as described in [`../typeorm/README.md`](../typeorm/README.md), adding `INTERLEAVE_TYPEORM_EXAMPLE=typeorm-0.3`. For the lifecycle job, first install this variant with `npm ci --prefix examples/typeorm-0.3 --ignore-scripts`. The job copies that installation into a private directory, adds the shared helper, and imports the helper from there. The functional gate needs no local install; it copies this `package.json` and lock into its new application.

The limits in [`../typeorm/README.md`](../typeorm/README.md#limits) apply unchanged. In particular, closing a client does not send PostgreSQL CancelRequest, acquisition can take up to the five-second pg timeout, and only SQLSTATE 40001 is retried.
