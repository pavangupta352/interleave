# Interleave — project status and roadmap

**Checkpoint: 27 September 2026 · Active development · No stable release yet**

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
| Version | `0.1.0` |
| Qualified source | `6291275` (source before the release-preparation commit, which changes the version, documentation and scaffold wording; the v0.1.0 tag reruns the full matrix); [CI run 36320529894](https://github.com/pavangupta352/interleave/actions/runs/36320529894) passed all 24 jobs |
| Release state | Public development repository; no tag, GitHub release or npm publication yet. npm publication needs the owner's `npm login`. |

## What works

| Area | Status | Verified scope |
| --- | --- | --- |
| Core engine | Integrated | Wire proxy with original protocol bytes, controlled release order, real lock-wait observation, bounded exploration (FIFO/seeded), exact and guided replay, failure-preserving minimization |
| Disposable databases | Integrated | Generated database per run, supervised workers, exact-resource cleanup, `--docker` managed PostgreSQL |
| Evidence | Integrated | Schema 3 run artifacts (protocol profile and transport identity), offline HTML report tested in Chromium, Firefox and WebKit at desktop and mobile sizes |
| Portable regressions | Integrated | Original source, lock and runtime archives, offline installation and exact replay; separate and shared layouts |
| Verified upstream TLS | Integrated | Certificate chain and URL hostname/IP on every PostgreSQL connection, TLS 1.2–1.3, bundled roots or a supplied CA; owned TLS-only servers on PostgreSQL 16/17/18 × Node 22/24 in CI; [qualification](docs/qualification/verified-upstream-tls-2026-09-27.md) |
| node-postgres | Integrated | PostgreSQL 16/17/18 × Node 22.18/24.7 |
| Postgres.js | Integrated | `describe-flush-v1` profile, transactions and conflicts |
| Drizzle, Kysely, pghybrid/pgvector | Integrated | Ordinary CRUD/transactions and installed workflows; PostgreSQL 17 + pgvector 0.8.6 |
| TypeORM 1.1.1 and 0.3.31 | Integrated | Functional (11 cases) and lifecycle (14 checks) gates on PostgreSQL 16/17/18 with Node 22.18 |
| Other languages | Integrated | `processActor`; Python with psycopg 3.3.6 qualified through an installed-package workflow |
| Historical case studies | Integrated | Knex #4694, node-pg-migrate #830, Sequelize #13482 with ordinary-concurrency, barrier and isolation-tester baselines; [case studies](docs/case-studies.md) |
| Prisma 7 | In progress | Driver-adapter workflow on `feature/prisma`; not yet integrated |
| Multi-connection actors | In progress | Design in [docs/plans/multi-producer-actors.md](docs/plans/multi-producer-actors.md); implementation on `feature/multi-session` |

## Known limits

- A passing bounded search is evidence about the explored orders, not proof of race freedom.
- Interleave releases one command at a time unless PostgreSQL reports a lock wait. Races that need two statements executing at the same instant can be missed; the Knex 0.95.12 case study measured such a miss.
- By default an actor holds one command-producing connection at a time. COPY, pipelining and CancelRequest are unsupported.
- Clocks, randomness and external services are not controlled.

## Roadmap

| Workstream | Next deliverable |
| --- | --- |
| Release 0.1.0 | Tag, CI release candidate, consumer acceptance on the exact archive, npm publication and GitHub release with checksums |
| Multi-connection actors | Lanes per connection, lazy lane binding for replay, schema 4, pool and ORM qualification |
| Statement overlap | An exploration mode that releases two commands together, to reach races like the Knex 0.95.12 miss |
| Prisma and more ORMs | Prisma 7 export packaging; Sequelize, Knex and MikroORM ordinary workloads |
| More languages | Go (pgx), Ruby (pg), Java (JDBC) through `processActor`, each with its own workflow |
| Hosted databases | Restricted roles, provider allocation, mutual TLS, channel binding, host-name overrides |
| Protocol features | COPY, cursors, CancelRequest, pipelining |
| Platforms | Native Windows process ownership and interruption; automated macOS CI |
| Other engines | Select a first non-PostgreSQL engine and design its own protocol, fixture and scheduling contract |
| Usability | An unaided first-user exercise with real participants |

## Working agreements

- Commits and releases use Pavan Gupta's identity.
- Tests run actual queries against actual PostgreSQL; failed attempts and original artifacts are preserved; unrun gates stay visible.
- UI changes follow the Impeccable workflow and the accessibility checklists.
- The private continuation ledger is `.local/CURRENT.md` (not in the public repository).
