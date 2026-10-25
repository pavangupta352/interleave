# Interleave — project status and roadmap

**Checkpoint: 25 October 2026 · 0.2.1 released · 0.3.0 on `feature/0.3.0` · Active development**

This page is the starting point for anyone picking the project up. It explains
what Interleave is, what works and how that was verified, what is in progress,
and what remains. It is a dated checkpoint, not a release announcement.

**Direction:** keep the whole roadmap open (no feature freeze). Ship verified
releases as each coherent set of work lands, starting with 0.1.0.

## At a glance

| Question | Current answer |
| --- | --- |
| What is it? | A tool that makes database races in real application code reproducible, explains the observed ordering, and keeps the failure as a regression test. |
| Owner | Pavan Gupta, GitHub `pavangupta352`; commits use `pavan.gupta.352@gmail.com`. |
| Repository | [pavangupta352/interleave](https://github.com/pavangupta352/interleave) |
| Package / executable | `@pavangupta352/interleave` / `interleave` |
| Version | `0.2.1` released; `0.3.0` on `feature/0.3.0` |
| Qualified source | `5b54b50`, tag `v0.2.1`; [tag CI run 40151506663](https://github.com/pavangupta352/interleave/actions/runs/40151506663) passed all 31 jobs, and the exact archive passed consumer acceptance on Node.js 22.18.0 and 24.7.0 ([validation](docs/validation.md)) |
| Release state | [v0.2.1 on GitHub](https://github.com/pavangupta352/interleave/releases/tag/v0.2.1) with the npm archive, source archive, manifest and `SHA256SUMS` (25 October 2026), after [v0.1.0](https://github.com/pavangupta352/interleave/releases/tag/v0.1.0) (27 September 2026). The `v0.2.0` tag was never released. npm publication is pending the owner's `npm login`. |

## What works

| Area | Status | Verified scope |
| --- | --- | --- |
| Core engine | Integrated | Wire proxy with original protocol bytes, controlled release order, real lock-wait observation, bounded exploration (FIFO/seeded), exact and guided replay, failure-preserving minimization |
| Disposable databases | Integrated | Generated database per run, supervised workers, exact-resource cleanup, `--docker` managed PostgreSQL |
| Evidence | Integrated | Schema 3 run artifacts (protocol profile and transport identity), schema 4 for lanes and overlap pairs, offline HTML report tested in Chromium, Firefox and WebKit at desktop and mobile sizes |
| Portable regressions | Integrated | Original source, lock and runtime archives, offline installation and exact replay; separate and shared layouts |
| Verified upstream TLS | Integrated | Certificate chain and URL hostname/IP on every PostgreSQL connection, TLS 1.2–1.3, bundled roots or a supplied CA; owned TLS-only servers on PostgreSQL 16/17/18 × Node 22/24 in CI; [qualification](docs/qualification/verified-upstream-tls-2026-09-27.md) |
| node-postgres | Integrated | PostgreSQL 16/17/18 × Node 22.18/24.7 |
| Postgres.js | Integrated | `describe-flush-v1` profile, transactions and conflicts |
| Drizzle, Kysely, pghybrid/pgvector | Integrated | Ordinary CRUD/transactions and installed workflows; PostgreSQL 17 + pgvector 0.8.6 |
| TypeORM 1.1.1 and 0.3.31 | Integrated | Functional (11 cases) and lifecycle (14 checks) gates on PostgreSQL 16/17/18 with Node 22.18 |
| Other languages | Integrated | `processActor`; Python with psycopg 3.3.6 qualified through an installed-package workflow |
| Historical case studies | Integrated | Knex #4694, node-pg-migrate #830, Sequelize #13482 with ordinary-concurrency, barrier and isolation-tester baselines; [case studies](docs/case-studies.md) |
| Prisma 7 | Released in 0.2.1 | Prisma ORM 7.10.0 checkout example and installed gate, 13 checks on PostgreSQL 16/17/18 × Node 22.18/24.7 |
| Multi-connection actors | Released in 0.2.1 | Connection lanes for pools and ORM side queries, lane-binding replay, schema 4 |
| Statement overlap | Released in 0.2.1 | `--overlap pairs` releases two commands together; finds the Knex 0.95.12 case-study miss |
| More languages | 0.3.0 | Ruby, PHP, Go and Java through `processActor`, each with an installed-package workflow and CI job |
| Sequelize, Knex, MikroORM | 0.3.0 | Per-actor helpers and a 14-check installed gate on PostgreSQL 16/17/18 × Node 22.18/24.7 (18 rows checked locally) |
| Cancel requests | 0.3.0 | Forwarded only to the sending actor's own backend, over plaintext or verified TLS; recorded in schema 5 with the step each request reached |
| Streaming COPY | 0.3.0 | COPY FROM STDIN / TO STDOUT inside one scheduled command with backpressure; byte counts and digests in schema 5 |
| Cursors and Flush stages | 0.3.0 | `flush-stages-v1` releases each Flush-terminated batch separately; pg-cursor, pg-query-stream, Postgres.js `cursor()` |

## Known limits

- A passing bounded search is evidence about the explored orders, not proof of race freedom.
- Interleave releases one command at a time unless PostgreSQL reports a lock wait. Races that need two statements executing at the same instant can be missed; the Knex 0.95.12 case study measured such a miss.
- By default an actor holds one command-producing connection at a time; `multi-producer-v1` schedules several. Clients that wait on Flush need `flush-stages-v1`. Replication and COPY BOTH are unsupported.
- The merged 0.3.0 branch, with cancel requests, COPY and Flush stages, passed all 52 CI jobs (run 40146537748) after an independent review's seven findings were fixed. It has not yet been tagged or put through release acceptance.
- Clocks, randomness and external services are not controlled.

## Roadmap

| Workstream | Next deliverable |
| --- | --- |
| Release 0.1.0 | Released on GitHub with checksums; npm publication of the same archive after the owner's `npm login` |
| Release 0.2.1 | Released on GitHub with checksums after tag CI and consumer acceptance of the exact archive; npm publication after the owner's `npm login` |
| Release 0.3.0 | More languages, Sequelize/Knex/MikroORM, cancel requests, streaming COPY and Flush stages; full CI on `feature/0.3.0`, then the same release gate |
| Prisma export | Portable export for Prisma's generated client |
| Pool replay | Exact replay of a pool that routes a later statement to a different connection stays `incompatible`. Exchanging two connections' bindings when their recorded commands match was built and rejected in review: matching commands and result summaries do not show that two sessions hold the same state (sequence `currval`, advisory locks, temporary tables), so it could turn a mismatch into a false match. Supporting it needs evidence of session state |
| Hosted databases | Restricted roles, provider allocation, mutual TLS, channel binding, host-name overrides |
| Protocol features | Qualify more drivers' cancel, COPY and cursor paths as users report them; replication stays out of scope |
| Platforms | Native Windows process ownership and interruption; automated macOS CI |
| Other engines | Select a first non-PostgreSQL engine and design its own protocol, fixture and scheduling contract |
| Usability | An unaided first-user exercise with real participants |

## Working agreements

- Commits and releases use Pavan Gupta's identity.
- Tests run actual queries against actual PostgreSQL; failed attempts and original artifacts are preserved; unrun gates stay visible.
- UI changes follow the Impeccable workflow and the accessibility checklists.
- The private continuation ledger is `.local/CURRENT.md` (not in the public repository).
