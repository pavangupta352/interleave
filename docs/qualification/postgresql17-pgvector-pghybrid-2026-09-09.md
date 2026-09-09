# PostgreSQL 17, pgvector 0.8.6, and pghybrid qualification — 2026-09-09

This record qualifies Interleave's explicit `postgresql17-pgvector0.8.6-v1`
fixture profile and one actual pghybrid 0.1.4 `forPg` workload. It supplements
the extension-free native PostgreSQL matrix.

## Environment

- Node.js 24.7.0 and npm 11.5.1
- node-postgres 8.23.0
- Docker Engine 28.3.3
- Linux arm64 container platform
- `pgvector/pgvector:0.8.6-pg17-bookworm`
- image ID and repository digest
  `sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`
- PostgreSQL 17.11 (`Debian 17.11-1.pgdg12+2`)
- vector extension 0.8.6
- pghybrid 0.1.4 from tag `v0.1.4`, commit
  `6b12e4c0d8bb25957554c41ac12c56653efad49d`

The image tag is mutable. The digest above identifies the image that was
actually exercised; it is separate from the database fixture fingerprint.

## Fixture contract

The profile requires PostgreSQL major 17 and the exact vector 0.8.6 extension
installed in `public`, owned by the capture role. Capture validates all 237
extension dependency members and pinned behavior-bearing projections of types,
functions and aggregates, casts, operators, access methods, operator families,
operator classes, family operators, and family support procedures. It also
validates the seven extension setting definitions and hashes their effective
values.

The capture tests prove stable identity across fresh database names and OID
allocation, and changed identity for vector values, nulls, multiplicity, typmods,
HNSW operator class and reloptions, and effective pgvector settings. Removed
extension members, member ACL changes, altered extension metadata, an extra
extension, and unowned lookalike operators fail closed. Vector, halfvec,
sparsevec, arrays with nondefault lower bounds, signed zero, maximum dimensions,
NaN and infinity handling, quiescence, cancellation, deadlines, and object, row,
and canonical-byte limits are exercised against the real server.

This is catalog and fixture identity. It is not native library binary
attestation. The immutable image digest records the tested binary/container
distribution separately.

## Results

The complete integration selection on the vector image passed 203 tests across
23 files in 100.27 seconds. It included the native database, proxy, protocol,
runner, replay, reduction, supervision, export, and example coverage, plus eight
pgvector fixture tests and the pghybrid workload. The focused pgvector fixture
selection passed all eight tests in 5.97 seconds.

After vector-only test routing was made explicit, the complete native selection
also passed against each actual official image without installing vector:

| Image | Observed server | Files | Tests | Duration | Result |
| --- | --- | ---: | ---: | ---: | --- |
| `postgres:16` | PostgreSQL 16.15 | 21 | 194 | 58.45 s | Passed |
| `postgres:17` | PostgreSQL 17.11 | 21 | 194 | 115.12 s | Passed |
| `postgres:18` | PostgreSQL 18.6 | 21 | 194 | 115.41 s | Passed |

The PostgreSQL 17 and 18 checks ran concurrently, so their elapsed times are not
performance comparisons. Their purpose was to prove the native matrix excludes
the vector-only files while retaining its prior extension rejection behavior.

The pghybrid scenario created 12 documents. Two actors used the unchanged packed
`forPg` API through independent pools with `max: 1`. The recorded run passed in
245.79 ms with two generated extended-protocol statements, then exact replay
matched the fixture, startup connections, SQL fingerprints, schedule, and both
ordered top-three results. The generated statement fingerprint was
`998b1addf1a7d69f8229b26ec3b1f6bf3e84383629a4cf8fe910a2672f9678bc`.

## Commands

```sh
INTERLEAVE_TEST_POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg17-bookworm \
  node scripts/test.mjs integration
INTERLEAVE_TEST_POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg17-bookworm \
  node scripts/test.mjs integration --run test/fixture-pgvector.pgvector.integration.test.ts
node scripts/test.mjs unit
npm run typecheck
npm run build
```

The complete run used owned container
`interleave-test-7732ec45-c23d-4b01-8a37-da1a3337d647`. The harness verified its
unguessable ownership label and exact container ID before removing the container
and anonymous volumes. A final label query found no residual owned test server.
The post-routing native runs likewise removed
`interleave-test-6e4fe7aa-a688-4ec1-a1a5-08d5533da81a`,
`interleave-test-fbbb11aa-505e-433a-aa1f-d3761ad4fe2b`, and
`interleave-test-b78f5d6a-81de-476f-b814-5f1ddea71c89`.

## Qualification boundary

The pgvector profile is explicit; the native profiles continue to reject vector
and other nonbaseline extensions. This record covers the exact PG17/pgvector
image and one pghybrid `forPg` read workload. It does not qualify other PostgreSQL
majors, pgvector releases or platforms, approximate-index behavior, pghybrid's
other driver adapters, TLS inspection, COPY, pipeline mode, or historical
application behavior.
