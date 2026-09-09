# Compatibility

Interleave's native PostgreSQL profile is qualified for PostgreSQL 16, 17, and 18. Each server major has a distinct fixture capture identity:

| PostgreSQL major | Fixture profile | Latest qualified server in this repository |
| --- | --- | --- |
| 16 | `postgresql16-native-v1` | PostgreSQL 16.15, official `postgres:16` image |
| 17 | `postgresql17-native-v1` | PostgreSQL 17.11, official `postgres:17` image |
| 18 | `postgresql18-native-v1` | PostgreSQL 18.6, official `postgres:18` image |

The server major is part of the fixture fingerprint. Strict replay therefore cannot treat fixtures captured on different PostgreSQL majors as equivalent. Artifact validation accepts all three profile names, while fixture capture rejects every other server major before reading application objects.

The qualification covers Interleave's native, extension-free fixture profile and its plaintext PostgreSQL protocol proxy using node-postgres 8.23.0. It exercises disposable database ownership and cleanup, schema/data/sequence/settings capture, queryless and reconnect startup binding, simple and ordinary extended query cycles, prepared statements, transaction errors, waits, replay, reduction, supervision, export, and the neveroversell example against each real server major.

The native fixture profile permits the built-in `plpgsql` extension. Other extensions, foreign relations, custom casts/operators, custom range/base types, temporary fixture state, logical replication configuration, and the other explicitly unsupported catalog features fail closed. pgvector and drivers other than node-postgres have separate qualification gates and are not covered by this matrix. The recorded database matrix ran on Node.js 24.7.0; the separate Node.js 22 release matrix remains pending.

PostgreSQL 17 renamed the catalog locale fields used by fixture capture from `daticulocale`/`colliculocale` to `datlocale`/`colllocale`. Interleave selects the fields by verified server major and retains a stable semantic `locale` field in its canonical input. It also includes ICU tailoring rules because they can change comparison behavior. See the official [PostgreSQL 17 release notes](https://www.postgresql.org/docs/17/release-17.html), [PostgreSQL 16 collation catalog](https://www.postgresql.org/docs/16/catalog-pg-collation.html), and [PostgreSQL 18 database catalog](https://www.postgresql.org/docs/18/catalog-pg-database.html).

PostgreSQL 18 virtual generated columns are covered by schema and logical row identity. The qualification verifies that otherwise equivalent stored and virtual generated columns have different schema identities while their application-visible values are captured. See the official [PostgreSQL 18 generated-column documentation](https://www.postgresql.org/docs/18/ddl-generated-columns.html).

## Running the database matrix

`npm run test:integration` provisions an owned `postgres:16` container when `TEST_DATABASE_URL` is absent. Select another qualified major with the exact official tag:

```sh
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:17 npm run test:integration
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:18 npm run test:integration
```

`INTERLEAVE_TEST_POSTGRES_IMAGE` accepts exactly `postgres:16`, `postgres:17`, or `postgres:18`. The harness binds a random loopback port, generates a random password, labels the container with an unguessable run identity, verifies that identity before cleanup, and removes the container and its anonymous volumes after the run. If `TEST_DATABASE_URL` is explicitly set, tests use that dedicated administrator endpoint instead of starting a container.

The dated, immutable image identities and measured test results are in the [native PostgreSQL qualification record](qualification/postgresql-native-matrix-2026-09-09.md).
