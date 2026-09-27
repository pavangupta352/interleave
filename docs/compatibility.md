# Compatibility

Interleave's native PostgreSQL profile is qualified for PostgreSQL 16, 17, and 18. Each server major has a distinct fixture capture identity:

| PostgreSQL major | Fixture profile | Latest qualified server in this repository |
| --- | --- | --- |
| 16 | `postgresql16-native-v1` | PostgreSQL 16.15, official `postgres:16` image |
| 17 | `postgresql17-native-v1` | PostgreSQL 17.11, official `postgres:17` image |
| 18 | `postgresql18-native-v1` | PostgreSQL 18.6, official `postgres:18` image |

The server major is part of the fixture fingerprint. Strict replay therefore cannot treat fixtures captured on different PostgreSQL majors as equivalent. Artifact validation accepts all three profile names, while fixture capture rejects every other server major before reading application objects.

The qualification covers Interleave's native, extension-free fixture profile and its plaintext PostgreSQL protocol proxy using node-postgres 8.23.0. It exercises disposable database ownership and cleanup, schema/data/sequence/settings capture, queryless and reconnect startup binding, simple and ordinary extended query cycles, prepared statements, transaction errors, waits, replay, reduction, supervision, export, and the neveroversell example against each real server major.

The native fixture profile permits the built-in `plpgsql` extension. Other extensions, foreign relations, custom casts/operators, custom range/base types, temporary fixture state, logical replication configuration, and the other explicitly unsupported catalog features fail closed. Drivers other than node-postgres have separate qualification gates and are not covered by this matrix.

At commit `4b589dbac81eeef7bdabf461b105dc9bb29113b6`, all six PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0 jobs passed 758 tests each. Both PostgreSQL 17 / pgvector 0.8.6 jobs passed their ten checks, and the browser job passed 20 checks at each desktop/mobile size in Chromium, Firefox and WebKit. This includes seeded search, the Postgres.js protocol, installed pghybrid replay, and the [replay and release hardening](qualification/replay-release-hardening-2026-09-09.md). See the [completed nine-job CI run](https://github.com/pavangupta352/interleave/actions/runs/34322912399). The tag-only assets job was correctly skipped for this main-branch run.

PostgreSQL 17 renamed the catalog locale fields used by fixture capture from `daticulocale`/`colliculocale` to `datlocale`/`colllocale`. Interleave selects the fields by verified server major and retains a stable semantic `locale` field in its canonical input. It also includes ICU tailoring rules because they can change comparison behavior. See the official [PostgreSQL 17 release notes](https://www.postgresql.org/docs/17/release-17.html), [PostgreSQL 16 collation catalog](https://www.postgresql.org/docs/16/catalog-pg-collation.html), and [PostgreSQL 18 database catalog](https://www.postgresql.org/docs/18/catalog-pg-database.html).

PostgreSQL 18 virtual generated columns are covered by schema and logical row identity. The qualification verifies that otherwise equivalent stored and virtual generated columns have different schema identities while their application-visible values are captured. See the official [PostgreSQL 18 generated-column documentation](https://www.postgresql.org/docs/18/ddl-generated-columns.html).

## Verified upstream TLS

Pass `upstreamTls: { mode: 'verify-full' }` in the API, `--upstream-tls` on the CLI, or `sslmode=verify-full` in the administrator URL. Every connection Interleave opens to PostgreSQL then verifies the server certificate chain and the URL hostname or IP address, using TLS 1.2 or 1.3 after PostgreSQL's SSLRequest negotiation. That covers database creation, setup and observer clients, fixture capture, the supervised worker's clients, each actor proxy's upstream session and cleanup. Trust is Node.js's bundled root set, or a PEM bundle you supply with `ca` / `--upstream-ca`, which replaces those roots rather than extending them (at most 1 MiB and 256 certificates). The policy and CA are resolved once per command or API call, so a CA file replaced mid-run cannot change cleanup trust.

Actors still connect to their own loopback endpoint in plaintext (`127.0.0.1`), and their driver's authentication bytes pass through unchanged. The first qualified authentication path is ordinary SCRAM-SHA-256 over the verified upstream connection. An actor that selects SCRAM-SHA-256-PLUS (channel binding) is refused with an explicit error, because the loopback leg has no upstream TLS channel to bind.

Not part of this profile: client certificates (mutual TLS), required channel binding, a verification name different from the URL host (tunnels), `sslmode` values other than `verify-full`/`disable`, direct TLS negotiation, and TLS on actor endpoints. `--docker` provisions a plaintext loopback server and cannot be combined with `--upstream-tls`.

The owned TLS qualification servers use official PostgreSQL images, `hostssl`-only authentication rules, SCRAM passwords and a generated private CA. They check both IP and DNS subject names, node-postgres ordinary cycles and the Postgres.js `describe-flush-v1` profile, and in-process and supervised file runs. They also cover exact replay, minimization, CLI `doctor` with `--upstream-ca`, and rejection of transport drift before any database work. The negative cases cover an unrelated CA, a certificate for another name, expired and not-yet-valid certificates, a wrong password and plaintext clients refused by the server. The [TLS qualification record](qualification/verified-upstream-tls-2026-09-27.md) lists versions, commands and unrun cases.

## Multi-connection actors

The explicit `multi-producer-v1` connection profile (`connectionProfile` in the
API, `--connection-profile` on the CLI) schedules each connection of an actor as
a lane; see [multi-connection actors](api.md#multi-connection-actors). It was
checked on 27 September 2026 against the official PostgreSQL 16.15, 17.11 and
18.6 images with Node.js 24.7.0, and against PostgreSQL 16.15 with Node.js
22.18.0. The checked applications are:

- node-postgres 8.23.0 `pg.Pool` (pg-pool 3.14.0) with `max: 2`: two concurrent
  read-modify-writes through `pool.query`, explicitly checked-out clients, and a
  side query through the pool while a checked-out client holds a transaction.
- Kysely 0.29.5 `PostgresDialect`: a transaction plus an availability check
  issued through the outer pool, which runs on a second connection.
- Postgres.js 3.4.9 with `max: 2` under `describe-flush-v1`, with metadata and
  execution stages open on both connections of one actor.

These runs recorded real lost updates and a double redemption, replayed them
exactly (including after the first pool socket was deliberately connected
second, which reverses accept order), reduced and explored lane-qualified
plans, and observed a real lock wait between two connections of one actor. A
connection blocked by an unscheduled session is `inconclusive`. The CLI path
covers supervised file runs, exact and guided replay, reduction, and an exported
bundle that installs offline and replays the recording exactly. The report shows
connection labels in Chromium, Firefox and WebKit at desktop and mobile sizes.

Keep each actor's pool within the per-actor cap (eight in this profile). Other
drivers, ORMs and pool implementations, larger pools and cancellation routing
have not been checked with this profile, and the complete release matrix (every
suite on each PostgreSQL major and Node.js version) has not yet run with it.

## Statement overlap

`overlap: 'pairs'` (`--overlap pairs`) releases the next commands of two actors or
lanes together; see [statement overlap](api.md#statement-overlap). It was checked
on 27 September 2026 against PostgreSQL 16.15 with Node.js 24.7.0, using a claim
that inserts a row only when none exists, in one statement that pauses after its
snapshot:

- Exploring without overlap tried every order and never failed; with overlap it
  found the duplicate claim on its third run, at the pair `alice+bob`.
- Exact replay of that pair repeated the failure, guided replay reran it, and
  reduction kept the pair as its one choice.
- An atomic `UPDATE ... SET value = value + 1` passed every sequential and
  paired choice.
- Postgres.js prepared statements under `describe-flush-v1` found the pair of
  execution stages, and replayed it exactly.
- A multi-producer pool paired two connections of one actor (`alice#0+alice#1`)
  and replayed through connection binding.
- The CLI recorded, replayed, reduced and reported the failure through supervised
  file runs, and the report marked the pair in Chromium, Firefox and WebKit.

The pause makes those checks deterministic. Real statements overlap for much less
time, so a real overlap failure can reproduce only some of the time. PostgreSQL
chooses how a pair interleaves; replay cannot force it.

## PostgreSQL 17 with pgvector 0.8.6

The separate `postgresql17-pgvector0.8.6-v1` fixture profile is qualified on
PostgreSQL 17.11 using the exact
`pgvector/pgvector:0.8.6-pg17-bookworm` image. It is selected explicitly with
`fixtureProfile: 'postgresql17-pgvector0.8.6-v1'` in the API or
`--fixture-profile postgresql17-pgvector0.8.6-v1` in the CLI. It never replaces
the extension-free native default.

This profile validates the exact vector extension membership and catalog
contract, effective pgvector settings, supported vector values, and the existing
native fixture surface. Qualification includes actual pghybrid 0.1.4 searches
recorded and exactly replayed through `forPg`, `forPostgresJs`, `forDrizzle` and
`forKysely`, using real callers. The [adapter qualification](qualification/pghybrid-adapters-2026-09-09.md)
records the exact versions, installed replay and interruption limits. See the
[pgvector and pghybrid qualification record](qualification/postgresql17-pgvector-pghybrid-2026-09-09.md)
and the [self-contained pghybrid example](../examples/pghybrid/README.md).

Vector must be installed in `public` and owned by the capture role. Catalog
identity does not attest the installed server binary.

## Running the database matrix

`npm run test:integration` provisions an owned `postgres:16` container when `TEST_DATABASE_URL` is absent. Select another qualified major with the exact official tag:

```sh
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:17 npm run test:integration
INTERLEAVE_TEST_POSTGRES_IMAGE=postgres:18 npm run test:integration
INTERLEAVE_TEST_POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg17-bookworm npm run test:integration -- pgvector
```

`INTERLEAVE_TEST_POSTGRES_IMAGE` accepts exactly `postgres:16`, `postgres:17`, `postgres:18`, or `pgvector/pgvector:0.8.6-pg17-bookworm`. The pgvector image enables the vector qualification files; the `pgvector` argument restricts the run to them. Without that argument, integration tests also run the native fixtures on the selected server. Native-image runs exclude vector files explicitly. The harness binds a random loopback port, generates a random password, labels the container with an unguessable run identity, verifies that identity before cleanup, and removes the container and its anonymous volumes after the run. If `TEST_DATABASE_URL` is explicitly set, tests use that dedicated administrator endpoint instead of starting a container; retain the image selector to choose the intended test profile.

The dated, immutable image identities and measured test results are in the [native PostgreSQL qualification record](qualification/postgresql-native-matrix-2026-09-09.md).

Run the explicit vector tests with:

```sh
INTERLEAVE_TEST_POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg17-bookworm npm run test:integration -- pgvector
```

Native jobs exclude files ending in `.pgvector.integration.test.ts`; the selected
vector profile runs them against an extension-capable server. Setting an image
while supplying `TEST_DATABASE_URL` selects the tests but does not change that
server: it must already provide the stated PostgreSQL and extension versions.

## Postgres.js protocol profile

Postgres.js 3.4.9 parameterized queries use the opt-in `describe-flush-v1`
protocol. Real Parse/Describe/Flush metadata and later Bind/Execute/Sync work
have separate release gates and schema-version-2 evidence. Cached prepared
queries can still use a complete-cycle release. See the [driver qualification
record](qualification/postgresjs-describe-flush-2026-09-09.md) and
[runnable example](../examples/postgresjs/README.md), including the required
driver shutdown listener for interrupted transactions.

The separate [transaction-conflict qualification](qualification/postgresjs-transaction-conflicts-2026-09-09.md)
records real `40P01` rollback and `40001` whole-transaction retries on PostgreSQL
16.13, with both preparation settings and explicit `fetch_types: false`.
PostgreSQL can choose another deadlock victim on replay; a resulting change in
the application's COMMIT/ROLLBACK order is correctly reported as incompatible.

## External programs as actors

`processActor` runs a separate program per actor and gives it only that actor's
loopback endpoint. Python with psycopg 3.3.6 (binary wheel, libpq 18) on Python
3.14 is qualified against PostgreSQL 16 through an installed-package workflow:
the unsafe [example](../examples/python/README.md) oversold, exact replay
reproduced the failure, an edited program was rejected as changed source, and the
repaired program passed a fully explored frontier of 47 schedules. That search
starts two Python processes per schedule and needs more than the default 60-second
search budget; the example and the `python` CI job give it ten minutes.
Separate Node.js programs using node-postgres are covered by the integration suite
in-process, including exact replay.

Other clients are expected to work when they read `DATABASE_URL` or the libpq
`PG*` variables, hold one command-producing connection at a time per actor, and
stay within the qualified protocol subset. Examples include libpq-based drivers,
pgx, Npgsql and JDBC. That subset covers simple queries and ordinary extended
cycles; it does not include COPY, pipeline mode or cancel requests. Those clients
have not been qualified. Treat them as unverified until their own workflow runs.

## TypeORM

The [TypeORM example](../examples/typeorm/README.md) gives each actor its own DataSource and a node-postgres pool of size one through TypeORM's public driver option. The helper and scenario are qualified unchanged with TypeORM 1.1.1 and 0.3.31 (each with its own lockfile), node-postgres 8.23.0, Node.js 22.18.0 and PostgreSQL 16, 17 and 18. Eleven functional cases per row cover entity CRUD, committed and rolled-back transactions with a real 23505, a real 40001 serialization failure handled by whole-transaction retry (and reported as an actor error without retry), the unsafe lost update with exact replay and minimization, source drift rejection, and original-archive export with offline installation and exported exact replay. Fourteen lifecycle checks cover acquisition, errors, backend termination and cancellation.

TypeORM 1.1.1 requires Node.js 20.19+, 22.13+ or 24.11+, so Node.js 24.7 is not a supported row. Closing a TypeORM client is not a PostgreSQL CancelRequest: a blocked backend can keep waiting until its blocker finishes or the generated database is cleaned up. Relations, `manager.transaction()`, pessimistic locks and deadlock retry have not been qualified.

## Prisma ORM 7.10.0

Prisma ORM 7.10.0 is qualified through its node-postgres driver adapter:
`@prisma/client` 7.10.0 and `@prisma/adapter-pg` 7.10.0 over `pg` 8.23.0, using
the default `sync-cycle-v1` profile. The `prisma-client` generator writes the
client into the application as TypeScript that Node.js 22.18.0 and 24.7.0 load
directly, so the generated files are recorded as scenario source. Each actor owns
one `PrismaClient` whose adapter pool has `max: 1`. Prisma sends BEGIN, COMMIT
and ROLLBACK as simple queries and model operations as parameterized extended
cycles; with the adapter's `statementNameGenerator`, every command is a named
prepared statement that node-postgres reuses on the same connection.

The [installed-consumer gate](../examples/prisma/README.md#qualification-gate)
passed all 13 checks with Node.js 22.18.0 and 24.7.0 against PostgreSQL 16.15,
17.11 and 18.6: CLI and library recording, exact replay and minimization,
rejection of an edited generated client and of a regenerated schema before any
import, byte-identical regeneration, serializable `40001`/`P2034` retry and the
unhandled actor error, `23505` rollback with CRUD on the same connection, named
statement reuse, and a guided rerun plus exhaustive fresh exploration after a
repair. See the [qualification record](qualification/prisma-orm-7.10.0-2026-09-27.md).

Boundaries of this profile:

- `@prisma/client` 7.10.0 alone installs 74,458,946 bytes; the example's recorded
  source identity is 82,478,406 bytes in 602 files, within the 128 MiB default
  budget. Builds with the earlier 64 MiB default, including the `3785d49`
  candidate and the 0.1.0 package prepared at `ebbadbc`, stop every Prisma
  7.10.0 recording as `inconclusive` with `Source identity byte limit exceeded`
  before any SQL runs.
- The recorded application must not install the Prisma CLI where its modules
  resolve packages. `@prisma/client` declares the CLI as an optional peer, and
  installed peers are recorded; with the CLI beside the client the closure is
  310,499,758 bytes in 10,437 files and exceeds every capture bound. Generate the
  client with a separately installed CLI, as the example does.
- Portable shared export is unsupported: the original
  `@prisma/client-7.10.0.tgz` is 26,828,688 bytes, above the 16 MiB per-archive
  bound. Export exits 2 without creating a bundle.
- Not qualified: Prisma 8, other driver adapters, Accelerate and Prisma Postgres,
  relation queries and nested writes, deadlock (`40P01`) handling, `prisma
  migrate` against the test server, and replay across Node.js or PostgreSQL
  versions.
