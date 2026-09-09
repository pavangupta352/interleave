# Interleave

Find a Postgres race in real application code, then keep the failing order as a regression test.

Interleave runs your concurrent operations against real PostgreSQL through a local proxy. You supply setup and an invariant; it controls command release order and records the evidence for replay.

![Recorded neveroversell failure: two buyers read the same stock before either writes. The report shows the released SQL, PostgreSQL completion, and violated capacity invariant.](docs/assets/evidence-record.png)

This actual run of [neveroversell's unchanged unsafe operation](examples/neveroversell/README.md) sold the last unit twice, with its optional delay set to zero. It is an owned demonstration, not a historical production defect.

The library, CLI, offline viewer and supported regression exports are implemented. Development and release qualification continue; there is no stable release yet. Start from this checkout.

## Try the oversell example

Use Node.js 22.18+ and a running Docker engine:

```sh
git clone https://github.com/pavangupta352/interleave.git
cd interleave
npm ci
npm test -- test/neveroversell.integration.test.ts
```

The test passes by reproducing the oversell, replaying it three times, and checking the original safe reservation API.

The npm pretest step builds Interleave. By default, the harness starts an owned `postgres:16` container on a random loopback port and removes it and its volumes after completion, failure or interruption. The first run may download the image. An explicit `TEST_DATABASE_URL` uses your dedicated test server instead and leaves it running.

## Record and inspect a failure

Set `TEST_DATABASE_URL` to the administrator URL of a **dedicated PostgreSQL test server** with permission to create and drop databases. The CLI uses that server and creates and cleans up a uniquely named database for each execution.

With that variable set, use the CLI built by the quickstart:

```sh
node dist/cli.js demo neveroversell --out failure.interleave.json
# Exit 1 is expected: the unsafe operation violates the invariant.
node dist/cli.js report failure.interleave.json --out failure.html
node dist/cli.js demo neveroversell --safe
```

Open `failure.html` to inspect the order, SQL, completions and observed lock waits. The [report](docs/reports.md) works offline without executing application code. Output files must be new, or explicitly replaced with `--force`. Review evidence before sharing: SQL, errors and selected actor observations can contain private data.

## Use your application

Define setup, two to eight named concurrent operations, and an invariant. Each operation receives a proxy URL and uses its existing driver and queries. Close its clients in `finally`; each actor defaults to one live physical connection.

The [library API](docs/api.md) and [CLI guide](docs/cli.md) cover the workflow:

| Operation | What it does |
| --- | --- |
| `explore` / `run` | Try bounded actor-choice prefixes and retain observed violations |
| `replay` | Check the recorded command and wait contract against captured starting conditions |
| `minimize` | Remove ordering instructions while reproducing the same invariant failure |
| `report` / `export` | Inspect the evidence offline or package a supported scenario for regression replay |

Prefer scenario files for supervised execution and source identity. Exact file replay checks source, installed dependencies, runtime, fixture and actor connections. After a repair, use a guided rerun or fresh exploration. Exact replay observes results again; row counts, actor values and the invariant outcome can differ. Reduction separately requires the same failure fingerprint and reports local minimality under the runner's fallback policy.

Search defaults to FIFO; an optional seed selects pending prefixes deterministically when observations match. Run, time, step and retention limits remain visible, including partial evidence. Keep the artifact for exact replay: a seed does not control external inputs, and a passing bounded search does not prove race freedom.

[Portable exports](docs/regressions.md) preserve the artifact, selected source, package lock and matching built runtime. Supported shared installations bundle exact dependency archives for offline installation. Byte verification and a successful clean-install replay are separate checks.

## Tested scope

The [compatibility matrix](docs/compatibility.md) covers PostgreSQL 16/17/18 with node-postgres 8.23.0 and Node.js 22.18.0/24.7.0 CI runs. Postgres.js 3.4.9 has an [explicit profile](examples/postgresjs/README.md) for parameterized queries. The [pghybrid example](examples/pghybrid/README.md) qualifies all four pinned public search adapters on PostgreSQL 17 with pgvector 0.8.6, including installed-package exact replay and documented caller shutdown limits.

The proxy preserves protocol bytes. PostgreSQL owns statement execution and lock resumption. SQL batches remain intact; server-side functions are opaque. Unsupported protocol and fixture features fail explicitly. Clocks, randomness and external services remain uncontrolled. The [architecture](docs/architecture/specification.md) and [validation records](docs/validation.md) detail these boundaries and remaining work.

## Development and related work

`npm test` runs the native unit and integration suites; `npm run test:unit` needs neither PostgreSQL nor Docker. See [contributing](CONTRIBUTING.md) for local checks and the [implementation plan](docs/plans/implementation.md) for remaining acceptance work.

[PostgreSQL's isolation tester](https://github.com/postgres/postgres/blob/master/src/test/isolation/README) already explores interleavings of authored SQL sessions. Interleave focuses on existing application operations and their replay evidence. [determined](https://github.com/glideapps/determined) provides deterministic TypeScript simulation primitives; [Antithesis](https://antithesis.com/) controls a broader execution environment.

## License

[MIT](LICENSE) © Pavan Gupta. Vendored application source and bundled dependencies retain their own [neveroversell](examples/neveroversell/vendor/LICENSE), [pghybrid](examples/pghybrid/vendor/LICENSE) and other required license notices.
