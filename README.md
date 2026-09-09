# Interleave

**Turn intermittent Postgres races into repeatable regression tests.**

Interleave runs existing application operations against real PostgreSQL and controls when their database commands are released. It finds invariant violations, shows the recorded command order, and retains evidence for replay and regression tests.

> Development is in progress. The API, CLI, offline viewer and supported regression export run end to end. File replay binds application source, installed dependencies, runtime, database fixture and actor connections. Broader compatibility, historical cases and release qualification remain in progress. There is no stable release yet.

![An actual oversell: both actors read the same stock before either writes, with the released SQL and PostgreSQL result visible in the evidence report.](docs/assets/evidence-record.png)

An actual PostgreSQL run of the unchanged `neveroversell` unsafe operation, with
its optional delay set to zero. Both buyers read one available seat before either
writes. The recorded invariant catches two purchases against a capacity of one.

## The problem

Two workers read the same row. Both decide they can claim it. Both proceed.

Running a test concurrently does not guarantee that the critical reads happen before either write. A successful run may simply have missed the ordering that exposes the bug.

The workflow is:

1. Define disposable database setup, concurrent application operations and an invariant.
2. Give each operation a local proxy connection URL, keeping its existing queries and driver.
3. Explore a bounded set of command orders against actual PostgreSQL.
4. Inspect the statements, completion summaries and observed lock waits behind a violation.
5. Reduce the ordering instructions and retain a verified replay fixture.

## What the scheduler controls

The proxy schedules complete driver command cycles. Simple Query batches remain intact; ordinary parameterized queries retain their original protocol bytes. PostgreSQL still owns query execution, transactions and lock resumption. Server-side functions are opaque.

Postgres.js parameterized queries have an explicit profile that separately gates
statement description and execution, using real PostgreSQL metadata. The default
complete-cycle profile stays unchanged. See the [tested profiles](docs/compatibility.md).

A passing exploration means no violation was observed in the schedules actually tested. It is not proof that the application has no races. Changed source, dependencies, fixtures or queries invalidate exact file replay; use a guided run or fresh exploration to evaluate a repair.

Exact replay checks the recorded command and wait contract against captured
starting conditions. Results are observed again: row counts, returned actor
values and the invariant outcome can differ when application behavior depends
on uncontrolled inputs such as randomness or external services. Reduction
additionally requires the same invariant failure fingerprint.

Each actor defaults to one physical connection. An explicit auxiliary profile
allows queryless monitor connections while retaining one live command producer.
See [compatibility](docs/compatibility.md) for measured PostgreSQL profiles and
[API boundaries](docs/api.md) for source capture, pools and replay.

## Development

The project targets Node.js 22.18+ and PostgreSQL. The initial driver qualification uses node-postgres. Current implementation work and acceptance gates are described in the [plan](docs/plans/implementation.md) and [architecture specification](docs/architecture/specification.md).

```sh
npm ci
npm run typecheck
npm test
```

`npm test` runs every unit and integration test. With Docker running, it starts an official `postgres:16` container on a dynamically assigned loopback port, waits for health, and removes that exact container and its anonymous volumes when tests finish, fail, or are interrupted. The first run may download the image.

Use `npm run test:unit` to run all unit tests without Docker or PostgreSQL. Use `npm run test:integration` for integration files only. Extra arguments reach Vitest unchanged, for example `npm test -- test/neveroversell.integration.test.ts`.

For desktop and mobile report checks in Chromium, Firefox and WebKit, install the browser runtimes with `npx playwright install --with-deps chromium firefox webkit`, then run `npm run test:browser`. These checks generate evidence from a real PostgreSQL execution and use the same disposable-server lifecycle.

To use an existing server, set `TEST_DATABASE_URL` to a **dedicated test PostgreSQL administrator database** with permission to create and drop databases, then run the same commands. Tests create and drop uniquely named `interleave_` databases; the harness leaves your supplied server running. The legacy `INTERLEAVE_TEST_DATABASE_URL` variable is accepted when `TEST_DATABASE_URL` is absent. There is no default connection to an existing local server. Direct `npx vitest run` integration runs require an explicit URL; the npm commands provision Docker when no URL is supplied.

Build the development CLI with `npm run build`, then run `node dist/cli.js --help`.
With `TEST_DATABASE_URL` set as described above, try:

```sh
node dist/cli.js demo neveroversell --out failure.interleave.json
# The deliberately unsafe demo exits 1 because it reproduces an oversell.
node dist/cli.js report failure.interleave.json --out failure.html
node dist/cli.js demo neveroversell --safe
```

Open `failure.html` locally to inspect the recorded order. Follow the
[CLI guide](docs/cli.md), [library API](docs/api.md), [offline report guide](docs/reports.md)
and [portable regression guide](docs/regressions.md) for the complete implemented
workflow. Registry installation instructions will accompany the verified release.

## Related work

[PostgreSQL's isolation tester](https://github.com/postgres/postgres/blob/master/src/test/isolation/README) already explores interleavings of authored SQL sessions. Interleave focuses on running existing application operations and retaining their evidence as regression artifacts.

[determined](https://github.com/glideapps/determined) provides deterministic TypeScript simulation primitives. [Antithesis](https://antithesis.com/) controls a much broader execution environment. A local statement proxy has different boundaries.

[neveroversell](https://github.com/pavangupta352/neveroversell) supplies an owned unsafe/safe workload for development. Its deliberately unsafe benchmark is not a historical production defect. The [pghybrid example](examples/pghybrid/README.md) runs the pinned library's actual hybrid search API on PostgreSQL 17 with pgvector 0.8.6, including installed-package exact replay. It is a compatibility workload; Interleave does not depend on pghybrid.

## License

MIT © Pavan Gupta. Reused third-party source retains its own attribution and notices.
