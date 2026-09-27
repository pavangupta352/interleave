# Verified upstream TLS qualification

This record covers the verified upstream TLS profile (`tls-verify-full-v1`) and
schema 3 run artifacts implemented in `3e386cb3327e6717780f14d5ba6fd8800da697a1` ("Verify upstream TLS across
the PostgreSQL lifecycle") and revised after independent review in
`d13afcb` ("Address review findings in verified upstream TLS") on top of the connector in `8e19350b44463fa62d21f473c5cb58d06f55f85b`, the
transport configuration in `d4f8280aa73a3f0f7e393a7e16a844af89aaf068` and the owned TLS qualification
servers in `fe2a8fad42d130adb2783ca6bddfc148a4dbb5ff`/`9a1208ff58573f52a82833476e7143fe1bea6342`.

## Contract

Every connection Interleave opens to PostgreSQL uses one transport snapshot
resolved per command or API call: database creation, generated-database setup
and observer clients, fixture capture, the supervised worker's clients, each
actor proxy's upstream session, and cleanup. The verified profile negotiates
TLS with PostgreSQL's SSLRequest (TLS 1.2-1.3) and checks the certificate chain
and the URL hostname or IP address. Trust is Node.js's bundled root set, or a
supplied PEM bundle that replaces it. Actor endpoints remain loopback plaintext
and their authentication bytes pass through unchanged; an actor selecting SCRAM
channel binding is refused. New artifacts record the policy, a fingerprint of the
trusted CA set and a fingerprint of the verified host name, never CA contents,
paths or credentials.

## Local execution

macOS arm64, Docker Engine 28.3.3, OpenSSL 3.6.3 for certificate generation, official `postgres:16` image
(PostgreSQL 16.15) for the owned servers. Each owned TLS server used a generated
private CA, `hostssl`-only authentication rules and SCRAM passwords.

| Check | Node.js 24.7.0 | Node.js 22.18.0 |
| --- | --- | --- |
| Unit suite (`npm run test:unit`) | 762 passed | 762 passed |
| TLS suite (`npm run test:tls`: owned servers, connector, lifecycle, product) | 25 passed | 25 passed |
| Integration suite against PostgreSQL 16 (plaintext regression) | 290 passed | not run locally |
| Offline report, Chromium/Firefox/WebKit at 1440 and 390 px | passed | not run locally |

The product checks in `test/tls/runner.test.mjs` and `test/tls/database.test.mjs`
observed, over real TLS connections:

- Every direct lifecycle connection role reported `pg_stat_ssl.ssl = true` with
  TLS 1.2 or 1.3: creation and cleanup administrators, setup and observer
  clients, both supervised-worker clients, an additional client built from
  `connectionOptions`, and fixture capture.
- A real lost update recorded with the private CA over the IP subject name, with
  both actors observing an encrypted upstream backend; exact replay reproduced
  the same failure fingerprint; minimization preserved it; a supervised file
  scenario recorded and replayed with the same transport identity; the DNS
  subject name (`localhost`) passed with SNI.
- Postgres.js actors with the `describe-flush-v1` profile completed staged
  parameterized queries over the verified upstream.
- Replay with plaintext, an unrelated CA, or a different host name was
  `incompatible` before any database work.
- CLI `doctor --upstream-tls --upstream-ca <file>` reported the enforced policy;
  `--docker --upstream-tls` was rejected.
- Negative cases failed before any generated database existed and without the
  password, certificate directory or PEM text in results: an unrelated CA,
  a certificate for another name (correct CA), and a plaintext administrator
  refused by the server's `hostssl` rules. Real-server connector checks
  additionally rejected expired and not-yet-valid certificates and separated a
  wrong password (SQLSTATE 28P01) from trust failures; loopback connector tests
  rejected an `N` reply, invalid negotiation bytes, premature close, stalled
  negotiation and handshake deadlines, and cancellation in both phases.

## Review

An independent security, concurrency and protocol review of the whole change
found no critical issues. Its two medium findings were fixed in `d13afcb`: actor
endpoints and plaintext setup/invariant URLs now select plaintext explicitly, so
an ambient `PGSSLMODE` cannot push actor drivers into TLS, and
`NODE_PG_FORCE_NATIVE` is refused because pg's native binding would drop the
verification settings. Lower-severity findings were also addressed: bounded
connection diagnostics on every path, harness-error classification for actor
upstream trust failures, refusal of pipelined authentication data, broader
certificate error classification, a specific error for unencoded URL
credentials, a bounded CA file read and direct `DeferredUpstream` tests. After
those fixes the unit suite passed 769 tests on Node.js 24.7.0 and 22.18.0, the
proxy integration tests 65 and the TLS suite 25.

## CI

[CI run 36320529894](https://github.com/pavangupta352/interleave/actions/runs/36320529894)
for the integrated source `6291275`, which includes the review fixes, passed all
24 jobs on Ubuntu 24.04: six native PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0
jobs, six `tls` jobs over the same matrix, two pgvector jobs, two managed CLI jobs,
the Python actor job, six TypeORM jobs and the offline report job.

Before the review fixes, [CI run 36317742627](https://github.com/pavangupta352/interleave/actions/runs/36317742627)
for exact source `3e386cb` passed all 17 jobs on Ubuntu 24.04:

- Six native jobs, PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0 (typecheck, unit
  and plaintext integration suites, package inspection).
- Six `tls` jobs, PostgreSQL 16/17/18 × Node.js 22.18.0/24.7.0, each running the
  complete owned TLS-only server suite (`npm run test:tls`).
- Two PostgreSQL 17 + pgvector 0.8.6 jobs, two managed local PostgreSQL CLI jobs
  and the offline report job in Chromium, Firefox and WebKit.

The tag-only release-asset job was skipped for this branch run.

## Not run

- Rotating the owned server's certificate between database creation and
  cleanup (cleanup must then report incomplete, never fall back to plaintext).
- Mutual TLS, required channel binding, host-name overrides, direct TLS
  negotiation and TLS on actor endpoints are outside this profile.
- Managed `--docker` servers remain plaintext.
