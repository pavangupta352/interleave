# Native PostgreSQL qualification record — 2026-09-09

This record qualifies the native Interleave fixture, proxy, runner, replay, reduction, supervision, regression export, and owned-example paths on three actual PostgreSQL server majors. It does not qualify extensions, other drivers, TLS inspection, or a different CPU/OS image platform.

## Environment

- Node.js: 24.7.0
- npm: 11.5.1
- node-postgres: 8.23.0
- Docker Engine: 28.3.3
- Container platform: Linux arm64
- Test runner: Vitest 5.0.0

The official image tags resolved to these immutable image identities during the run:

| Tag | Actual server | Image digest |
| --- | --- | --- |
| `postgres:16` | PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) | `sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94` |
| `postgres:17` | PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) | `sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675` |
| `postgres:18` | PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2) | `sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280` |

For these images, the image ID and the single repository digest were identical to the digest listed above.

## Results

The same complete integration selection ran separately against each managed server:

| Server | Fixture profile observed | Files | Tests | Vitest duration | Result |
| --- | --- | ---: | ---: | ---: | --- |
| PostgreSQL 16.15 | `postgresql16-native-v1` | 15 | 136 | 34.45 s | Passed |
| PostgreSQL 17.11 | `postgresql17-native-v1` | 15 | 136 | 40.15 s | Passed |
| PostgreSQL 18.6 | `postgresql18-native-v1` | 15 | 136 | 32.51 s | Passed |

The integration selection included database lifecycle, exploration, fixture identity, runner and lifecycle, proxy/protocol, strict replay fixture/startup binding, minimization, supervision, CLI, portable export/runtime installation, and neveroversell tests. The tests execute actual PostgreSQL queries; no server simulator or relabeled endpoint was used.

The final non-database selection passed 163 tests across 13 files. `tsc --noEmit` and the production build passed after the matrix.

## Version-specific evidence

- PostgreSQL 17 and 18 fixture capture uses the renamed `pg_database.datlocale` and `pg_collation.colllocale` fields. PostgreSQL 16 uses `daticulocale` and `colliculocale`. All profiles serialize the selected values under the same semantic locale key.
- ICU locale tailoring rules are included in database and collation canonical inputs. A regression recreates the same named ICU collation with changed rules and observes a changed schema component on the official images.
- A PostgreSQL 18 regression creates the same generated column as `STORED` and `VIRTUAL`, verifies the real computed value, and observes distinct schema components.
- Existing adversarial fixture tests passed on all three majors, including canonical byte limits, quiescence, ACL distinctions, reserved-namespace objects, custom casts/operators, sequence rechecks, effective startup settings, internal foreign-key triggers, row multiplicity, materialized views, and partition data.

## Commands

```sh
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:16 node scripts/test.mjs integration
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:17 node scripts/test.mjs integration
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:18 node scripts/test.mjs integration
node scripts/test.mjs unit
npm run typecheck
npm run build
```

The three full integration containers were:

- `interleave-test-f461709d-68a7-4caf-8a98-3e34df19f097` for PostgreSQL 16;
- `interleave-test-790de535-ac80-4115-a354-3accf5fd5671` for PostgreSQL 17;
- `interleave-test-3c2e8db3-777f-459d-b23e-b819bfecece0` for PostgreSQL 18.

For each run, the harness verified its private ownership label and exact container ID before forced removal with volumes. A final Docker label query returned no residual `io.interleave.test-run` containers.

## Qualification boundary

This matrix establishes the native server-major profiles on the exact Linux arm64 images above. PostgreSQL maintenance tags are mutable, so future release qualification must record the newly resolved digest and rerun the matrix. Node.js 22, other platforms, pgvector and other extensions, Postgres.js, ORMs, TLS termination, COPY, cancellation routing, and pipeline mode remain separate gates.
