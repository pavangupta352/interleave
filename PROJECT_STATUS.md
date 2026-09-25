# Interleave — project status, full roadmap and pause handoff

**Checkpoint: 25 September 2026 · Development paused at Pavan's request · Project not complete**

This is the starting point for the next session. It explains the product, what works, what remains unfinished, where the unfinished source lives, what the tests actually establish, and the order for continuing. It is a dated checkpoint, not a release announcement.

**Latest direction:** keep the whole roadmap open. Pavan explicitly rejected a feature freeze and asked for thorough documentation before pausing. The earlier proposed PostgreSQL-only release boundary is not an approved scope reduction. PostgreSQL work is the current engineering sequence; broader compatibility remains part of the ambition. Do not resume implementation or tests until Pavan resumes the project.

## At a glance

| Question | Current answer |
| --- | --- |
| What are we building? | A tool that makes database races in real application code reproducible, explains the observed ordering, and packages the failure as a regression test. |
| Owner | Pavan Gupta, GitHub `pavangupta352`; commits use `pavan.gupta.352@gmail.com`. |
| Project folder | `/Users/pavan/dev/interleave` |
| Public repository | [pavangupta352/interleave](https://github.com/pavangupta352/interleave) |
| Package / executable | `@pavangupta352/interleave` / `interleave` |
| Current version | `0.1.0-dev.0` |
| Last qualified application source | `3785d496747650cdf095998a1bd8b9882a670cc2` |
| Release state | Public development repository; no stable tag, GitHub release or npm publication recorded. |
| What already works? | Core runner, scheduling, exploration, exact/guided replay, minimization, CLI/API, disposable PostgreSQL, portable exports, offline reports and several qualified driver workloads. |
| What is being built now? | Verified upstream TLS across the entire lifecycle, schema 3 transport identity, and broader TypeORM qualification. These changes are in separate worktrees, not integrated into main. |
| Why paused? | User request. This is not project completion or abandonment. |
| Resume entry point | Read this document, then `.local/CURRENT.md`, then the handoff for the workstream being resumed. |

The source identity above refers to application behavior. A documentation-only commit containing this checkpoint can follow it without making the unfinished TLS or TypeORM work part of main.

## Contents

1. [Product and intended experience](#product-and-intended-experience)
2. [Architecture and behavior contracts](#architecture-and-behavior-contracts)
3. [Completed work](#completed-work)
4. [Verification and its limits](#verification-and-its-limits)
5. [Unfinished TLS work](#unfinished-tls-work)
6. [Unfinished TypeORM work](#unfinished-typeorm-work)
7. [Full remaining roadmap](#full-remaining-roadmap)
8. [Release and distribution gates](#release-and-distribution-gates)
9. [Exact workspace and evidence map](#exact-workspace-and-evidence-map)
10. [Resume sequence](#resume-sequence)
11. [Working agreements and continuity](#working-agreements-and-continuity)

## Product and intended experience

### The problem

A concurrency bug can appear only when two real application operations reach the database in a particular order. Repeatedly launching requests may miss it. Adding sleeps can make an example happen without explaining the actual ordering or providing a durable regression.

Interleave runs the actual operations through local PostgreSQL proxy endpoints. It controls when database command units are released, lets PostgreSQL execute them, observes completion and real lock waits, and evaluates an application invariant. It preserves enough source, dependency, environment, fixture and scheduling identity to distinguish an exact replay from a changed experiment.

For example, two buyers can both read the last unit of stock before either updates it. The unsafe operation oversells. The recorded report shows the actual reads, writes, completions and violated invariant. The original failing case remains useful after the operation is repaired, but the repaired source must be tested as changed source rather than falsely labeled an exact reproduction.

### Who should be able to use it

- Application developers diagnosing intermittent database races.
- Maintainers converting a known concurrency defect into a regression test.
- Teams checking business invariants in CI against bounded schedules.
- Library and ORM maintainers validating declared transaction and connection profiles.

The broader goal is low-friction adoption across real projects, drivers, operating systems and eventually additional runtimes and database engines. Each addition needs its own execution, identity, cleanup and compatibility contract; compatibility is not inferred from a logo or one successful query.

### The complete user journey

1. Install from supported distribution, or use the documented development checkout while no stable package exists.
2. Run `doctor` and an actual unsafe/safe example with a disposable database.
3. Define setup, two to eight named operations, and a business invariant; inject each actor's proxy URL into the existing application code.
4. Explore bounded orders and retain a failure artifact when an invariant breaks.
5. Inspect the offline report: actor order, SQL, transaction state, actual waits, outcomes and limits.
6. Replay the original case against its recorded source and starting conditions.
7. Minimize ordering instructions while preserving the same invariant failure.
8. Export an original-source regression bundle with dependency/runtime integrity and an offline installation path.
9. Repair the business code; use a guided rerun or fresh exploration and retain a CI regression.
10. Share reviewed evidence or a portable reproduction without accidentally including credentials or private application data.

The core journey already executes on the qualified development candidate. The remaining work is substantial compatibility, lifecycle, release and evidence work—not a blank repository and not a finished universal tool.

### What quality means here

The project should be useful, understandable, robust and easy to adopt. Success means real working workflows, precise limits, actionable errors, credible evidence and maintainable code. Broad use and recognition are goals; novelty, universal correctness, perfect coverage and virality are not established facts.

Existing related work is acknowledged in the [README](README.md). PostgreSQL's isolation tester already explores authored SQL interleavings; simulation and broader deterministic-environment tools also exist. Interleave's intended value is the integrated workflow around existing application operations, evidence, replay and regression packaging.

## Architecture and behavior contracts

| Layer | Responsibility | Main source |
| --- | --- | --- |
| Scenario/API | Setup, named actors, invariant and execution budgets | `src/types.ts`, `src/scenario.ts`, `src/index.ts` |
| Database lifecycle | Generated database ownership, setup/observer clients, teardown and uncertainty | `src/database.ts`, `src/attached-database.ts` |
| Wire protocol | Bounded framing, command assembly, original bytes and completions | `src/protocol/`, `src/proxy.ts` |
| Scheduling | Actor choices, release versus completion, actual lock observations | `src/scheduler.ts`, `src/runner.ts` |
| Supervision | Source-bound worker execution, parent ownership and cancellation | `src/supervised.ts`, `src/worker.ts` |
| Exploration/replay/reduction | Choice-prefix search, exact/guided rules, failure-preserving reduction | `src/explore.ts`, `src/replay.ts`, `src/minimize.ts` |
| Identity/artifacts | Source/dependencies, fixtures, startup state, bounded schema validation | `src/source-identity.ts`, `src/fixture-identity.ts`, `src/artifact-schema.ts` |
| Portable regressions | Original-source/runtime/archive preservation and offline verification | `src/export.ts` and export helpers/tests |
| CLI/setup | Shared commands, managed local database, doctor and diagnostics | `src/cli.ts`, `src/cli/`, managed database helpers |
| Evidence viewer | Standalone offline report and accessible interactions | `src/report/`, `test/browser/` |

Important invariants to preserve:

- Queries run against real PostgreSQL. The scheduler does not simulate database execution or rewrite application SQL.
- Original protocol bytes survive forwarding. Simple Query batches and qualified extended-query units remain indivisible at their declared scheduling boundary.
- Release and completion are different events. PostgreSQL owns execution, locks and backend resumption.
- An elapsed delay is not proof of a lock wait; wait claims require database observations.
- Actor endpoint identity and connection generation are recorded. The current qualified actor contract does not permit arbitrary simultaneous command-owning sessions.
- Exact replay checks recorded source, dependencies, runtime, fixture, startup and command/wait identity. It observes results again; it does not promise every returned value is deterministic.
- Guided replay is explicitly changed evidence. An incompatible run, actor error, timeout, unsupported profile or incomplete cleanup must never become a passing test by accident.
- Minimization removes ordering instructions, not arbitrary SQL. Minimality is local to the runner's fallback policy.
- A completed bounded search is evidence about that explored frontier, not proof that all possible executions are race-free.
- Database/container cleanup targets exact task-owned resources. Existing development databases and other projects are preserved.
- Artifacts can contain application SQL and observations. Harness credentials, private keys and transport secrets must not leak into public evidence.

See the [product brief](PRODUCT.md), [engineering specification](docs/architecture/specification.md), [concepts](docs/concepts.md), [API](docs/api.md) and [original acceptance plan](docs/plans/implementation.md) for the detailed contracts. Checked boxes in the original plan refer to that accepted profile, not every later expansion.

## Completed work

Status terms used throughout this handoff:

- **Integrated:** on main, within the stated qualified scope.
- **Branch milestone:** implemented and tested in an isolated branch, not shipped on main.
- **Partial:** source exists but remaining implementation, failing tests or review prevents integration.
- **Planned:** no support claim; implementation/qualification remains.
- **Blocked/unrun:** a gate has not completed; existing evidence must not be relabeled.

| Area | Status | What is done / remaining boundary |
| --- | --- | --- |
| Original research | Completed | Original conversation and research folder, including PDFs/Markdown, were audited earlier. Preserve the audit; do not restart research after every compaction. |
| Repository/toolchain | Integrated | Public repository, TypeScript/Node package, CLI build, locked dependencies, author identity and contributor/security/license files. |
| Protocol and scheduling | Integrated | Real query gating, fragmentation/state checks, ordinary and explicit staged profiles, completion/wait evidence, actor ordering and bounded failure categories. |
| Disposable execution | Integrated | Unique database ownership, setup/observer/capture, supervision, cancellation and cleanup evidence; ambiguous ownership is retained as uncertainty. |
| Search | Integrated | Bounded exploration, frontier/stop reasons and optional seeded prefix selection. |
| Replay/minimize | Integrated | Strict source-bound replay, guided changed-source behavior, failure identity and local reduction. |
| Portable exports | Integrated | Original source/lock/runtime bytes, archive integrity, supported separate/shared installation layouts, offline installation and original replay. |
| Managed PostgreSQL | Integrated | `--docker` route, random loopback port, exact container ownership and interruption/stream handling; explicit administrator-URL route remains. |
| CLI and API | Integrated | `init`, `doctor`, `demo`, `run`, `replay`, `minimize`, `report`, `export` and matching library workflows. |
| Offline reports | Integrated | Actual artifact viewer, filtering/selection, keyboard access, SQL/results detail, import/download, hostile-input and offline checks. |
| Report inclusion improvements | Integrated | Accessible evidence names, long-evidence navigation, selection/context and bounded larger-actor/report cases; existing design retained. |
| Onboarding and application/CI docs | Integrated | README-to-demo, application injection, original versus repaired source, export/install and CI journeys. Literal consumer recipes now executed on two Node toolchains. |
| node-postgres | Integrated | Pinned `pg@8.23.0`, native PostgreSQL 16/17/18 profile and Node 22/24 matrix. |
| Postgres.js | Integrated | Pinned 3.4.9, explicit `describe-flush-v1`, qualified parameterized/transaction/conflict paths with documented shutdown limits. |
| pghybrid / pgvector | Integrated | Pinned pghybrid 0.1.4 public adapters; PostgreSQL 17 + pgvector 0.8.6 profile. This does not qualify arbitrary extension/ORM features. |
| Ordinary Drizzle/Kysely | Integrated | Separate CRUD/transaction and installed workflow coverage, beyond pghybrid search. Consolidated public compatibility wording still needs reconciliation with the newer evidence. |
| Package/release preparation | Integrated tooling | Actual archive content checks, reproducible preparation, verification, clean installed smoke and CI preparation. No stable publication yet. |
| TLS trust resolver | Branch milestone | Closed, immutable verified transport configuration; focused and ordinary unit verification. No main runtime activation. |
| Owned TLS test infrastructure | Branch milestone | Real TLS-only PostgreSQL fixture, generated certificates, interruption/ownership/cleanup tests. Test infrastructure does not establish product TLS support. |
| TLS connector | Partial | 20 focused and four real connector tests passed; uncommitted, pending review and integration. |
| TLS schema 3 | Partial | 176 focused tests passed; full unit suite has 61 failures from the incomplete migration. |
| Direct-client TLS integration | Partial | Real failing acceptance test exists. Production lifecycle wiring has not been implemented. |
| TypeORM lifecycle | Branch milestone | 14 real lifecycle checks passed for the new helper on Node 22/PostgreSQL 16; commit exists, not integrated. |
| TypeORM full workflow | Partial | Three drafts exist. Latest runner failed before installation; new functional cases have not executed. |
| Prisma | Planned | Package/generation/engine constraints researched; no installation or generation qualification. |
| Historical cases and baselines | Blocked/unrun | Partial preparation/evidence exists; original required studies remain incomplete. See release gates below. |
| Stable release / registry / launch | Not completed | Source repository is public; final source qualification, tag/package publication, download checks and launch assets remain. |

## Verification and its limits

### Main source: `3785d49`

[CI run 34348877859](https://github.com/pavangupta352/interleave/actions/runs/34348877859) completed successfully for that exact source:

- Six native jobs: PostgreSQL 16/17/18 × Node 22.18.0/24.7.0.
- Two PostgreSQL 17 + pgvector 0.8.6 jobs, one for each Node version.
- Two managed local PostgreSQL CLI jobs, one for each Node version.
- One offline report job covering Chromium, Firefox and WebKit.
- Release-asset preparation was skipped because this was not the release-tag path.

The earlier `dff8a71` CI run failed one installed ordinary-ORM replay test at its 10-second invocation limit. That failure remains recorded. The fixture was corrected to supply the same explicit 30-second budget at all five relevant command sites; the product's default timeout was not changed. `3785d49` is the subsequent successful run, not a relabeling of the earlier result.

### Canonical development archive

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `pavangupta352-interleave-0.1.0-dev.0.tgz` | 1,826,236 | `ea06841e67437bd2a02bf509368317bb74f597235a273e5f1f881648f4c561e5` |
| Source archive for `3785d49` | 719,280 | `8fd6237ad7bb0f3d0e76ea86be6d63f0cc78bb4f01fa24db5e280554ae70e7a3` |

Stored in `.local/expansion/candidate-3785d49/`. Preparation and independent verification passed. Two clean builds with the same toolchain produced identical archive bytes. The prepared manifest has no release tag or final qualification attestation; later consumer evidence is separate. Never overwrite these assets with a package from newer source.

### Actual consumer acceptance

Fresh public clones and the same original canonical archive passed the reviewed workflows on macOS arm64 with:

- Node 22.18.0 / npm 10.9.3.
- Node 24.7.0 / npm 11.5.1.

Each successful run contains 48 subprocess records: 31 recipe records and 17 exact-container absence checks. Across both runs, 34 exact containers were absent and six dedicated database-catalog comparisons retained only their baseline databases. All 294 package payload files matched the canonical installation. These are subprocess/resource observations, not a count of independent product features.

The executed recipes include clone/install/build, managed doctor, unsafe and safe demos, report generation, bare ESM import, scaffold, imported application record/exact/minimize, original export, pre-install bundle verification, offline installation and original replay, unsafe CI failure, changed-source rejection and fresh repaired CI success.

Important observed distinctions:

- Unsafe operation: expected invariant failure, exit 1.
- Exact replay after source repair: incompatible, exit 3, zero SQL releases.
- Guided attempt after repair: exit 3; the old four-choice plan could not be consumed by the changed two-release operation. It was not called a pass.
- Fresh repaired exploration: three retained passing runs, frontier exhausted, pending zero and no violations.
- Application flows used PostgreSQL 16.15. A separate PostgreSQL 17 doctor check does not make this entire recipe a PostgreSQL 17 matrix run.
- Node 22's locally repacked gzip bytes differed from the canonical archive, while all extracted package files matched. Both installed routes used the unchanged original canonical bytes.

Evidence: `.local/expansion/consumer-acceptance/FINAL-REPORT.md`, `FINAL-RESULTS.json`, `FINAL-EVIDENCE-INDEX.json`. The index covers 574 decisive files and was independently rehashed. Index SHA-256: `b92c91e6fca5969a4caead3e26ccf1cbeef203e3f1b54c5f189afedb484e1153`.

Two earlier private runner failures remain preserved: CommonJS resolution of an ESM-only export, and an incorrectly timed bundle-verification call after installation added files. Successful runs used fresh directories after narrow runner corrections.

This evidence does **not** qualify the unfinished TLS/TypeORM changes, a public npm download, a hosted run of the documentation's CI template, all operating systems or arbitrary client features. Report generation in this consumer gate was not a new visual/accessibility audit; the browser CI evidence is separate.

### Other accepted evidence

The dated records in [docs/qualification](docs/qualification/) retain native matrix, source replay, Postgres.js, transaction-conflict, shutdown, pgvector/pghybrid, search, hardening, managed PostgreSQL and canonical-package milestones. Those records belong to their named sources. Older candidate archives and failures remain immutable historical evidence.

## Unfinished TLS work

### Selected first transport contract

The detailed plan is `.local/expansion/upstream-tls-plan.md`; selected decisions are `.local/expansion/upstream-tls-decisions.md`.

- Verify both certificate chain and URL hostname/IP for every upstream connection role.
- TLS 1.2–1.3 using PostgreSQL SSLRequest negotiation.
- Explicit Node-bundled trust or a bounded caller-supplied replacement CA bundle. Snapshot trust once per top-level operation; do not silently add ambient/system roots.
- Preserve ordinary SCRAM authentication bytes. The actor-facing leg remains loopback plaintext in this first profile.
- Expose fresh strict `pg` connection options for additional setup/invariant clients. This is a `pg` configuration contract, not a universal driver adapter.
- Record transport separately from protocol scheduling in schema 3.
- Keep schema 1/2 strictly readable. Exact execution on the new runtime requires guided migration when historical transport identity is absent; keep original exported runtimes available for original replay.
- Frontend TLS, mutual TLS, required channel binding, hostname overrides, provider provisioning and token refresh remain additional work on the open roadmap.

### Foundation — completed branch milestone

`feature/tls-foundation`, commit `1251decfd92d0628b3458c52468a57e5daf4ffe4`:

- `src/postgres-transport.ts` provides resolution, snapshot restoration, TLS options and explicit `pg` client configuration.
- Bounded URL/CA input, closed policy objects, immutable snapshots, canonical trust/reference fingerprints and secret-safe configuration errors.
- 98 focused tests on Node 22; 652 ordinary unit tests across 31 files on Node 24; typecheck/build passed. Focused Node 24 checks also passed.
- Main integration has not happened. Do not mistake the internal resolver for usable end-to-end TLS.

### Real TLS fixture — completed branch milestone

`feature/tls-fixture`, commits `d066d0c` and `875111e`:

- Temporary private CA, unrelated CA, valid DNS/IP certificate, wrong-name, expired and future certificates.
- Exact-owned official PostgreSQL container, TLS-only host rules, ordinary SCRAM, private key permissions and cleanup.
- 18 explicit checks passed on Node 24.7 / PostgreSQL 16.15 / OpenSSL 3.6.3.
- Interruption tests retain the original Docker ownership reply before cleanup; ambiguous create failures stay explicitly unconfirmed.
- A descendant-held-stdio timeout defect was reproduced and fixed with bounded termination of the exact owned command group. Parent cancellation still follows the original ownership-reply discipline.

No private keys belong in public source. Fixture evidence is in `.local/worktrees/tls-fixture/.local/`. `FIXTURE-REVIEW.md` independently reviews `d066d0c` and identifies the descendant-held-stdio defect. The later `875111e` correction has implementation-owner verification; independent review closure of that correction still needs confirmation. Certificate rotation after CREATE remains an unexecuted product acceptance case.

### Connector — passing focused checks, unfinished integration

`feature/tls-connector`, HEAD `64a57279d7f1c20e5cbee02c52ab439ae3f6bf4a`, three untracked files:

```text
src/protocol/upstream-transport.ts
test/upstream-transport.test.ts
test/tls/upstream-transport.test.mjs
```

The draft connector accepts a resolved snapshot plus signal/deadline, sends exact SSLRequest bytes, accepts only the correct one-byte negotiation reply, and yields a verified socket before any actor bytes can be forwarded. Failure, timeout and cancellation own both raw and TLS sockets. There is no plaintext fallback.

Observed checks: 20 focused failures against a stub, then 20 passes; build exit 0; four real TLS checks passed on Node 24/PostgreSQL 16. The real relay exercised SCRAM, a prepared parameter query returning 42, a transaction and `pg_stat_ssl`, wrong CA/name/time validity and wrong password. All four exact containers and private certificate directories were absent; relay sockets closed.

The relay is test-only, not the production scheduling proxy. Full ordinary unit verification of this delta, Node 22 connector coverage, independent source review and commit remain. Review the success-handoff listener/microtask ordering explicitly; it is a review concern, not yet a reproduced defect. Typecheck emitted no diagnostics, but its separate exit code was not captured.

Handoff: `.local/expansion/tls-connector/PAUSED-HANDOFF.md`; exact source/evidence/cleanup index: `PAUSED-VERIFICATION.json` in that directory.

### Artifact schema — partial, full suite failing

`feature/tls-artifact`, HEAD `1251dec`, six modified/new files:

```text
src/artifact-schema.ts
src/environment.ts
src/replay-readiness.ts
src/types.ts
test/staged-artifact.test.ts
test/transport-artifact.test.ts
```

Implemented draft: strict schema 3 transport wrapper, explicit ordinary/staged protocol dispatch, transport equality, legacy readability and missing-transport guided-migration diagnostic. Raw hostnames, CA contents/paths and weakened policy fields are not accepted as artifact transport identity.

Verification: meaningful corrected pre-implementation result of 21 failures; 176 focused tests subsequently passed; typecheck/build passed. **Full unit suite: 675 passed, 61 failed.** The failures are across six existing export fixture files whose evidence lacks the new transport identity. One secondary undefined-path failure occurs because a later injection point is never reached.

Required closure: integrate real v3 runtime emission, migrate current synthetic test fixtures properly, and rerun every affected export boundary so the original integrity assertions actually execute. Do not add fake transport to historical artifacts, weaken readiness or suppress failures. Review remains pending; do not merge this branch alone.

Handoff with all 61 failed names: `.local/worktrees/tls-artifact/.local/tls-artifact/HANDOFF.md`.

### Direct clients and runtime — at the first failing acceptance test

`feature/upstream-tls`, HEAD `1cc9a02`, based on the foundation plus the fixture:

- New untracked `test/tls/database.test.mjs` exercises actual create/setup/observer/worker attachment/extra client/fixture capture/fresh cleanup connections with a private CA.
- Build succeeded. The test currently fails with PostgreSQL's plaintext HBA rejection: the existing direct clients still ignore the proposed transport snapshot.
- This is an expected feature RED, not a completed implementation. No production lifecycle wiring has been changed in this worktree.
- `.local-install.log` is an untracked install log, not product source. Retain or move into ignored evidence before staging future code.

Next implementation obligations:

1. Thread one resolved snapshot through `database.ts`, `attached-database.ts`, `fixture-identity.ts` and all create/setup/observer/capture/cleanup paths.
2. Reassign only the generated database path while preserving trust provenance; do not turn bundled-root trust into a newly resolved custom bundle accidentally.
3. Add internal owned-database transport/configuration and public setup/invariant `connectionOptions` without disturbing unrelated schema-owned type regions.
4. Resolve effective credential/default behavior consistently between parent and scrubbed worker environments. The foundation intentionally leaves this integration decision open.
5. Carry the bounded snapshot through supervision/worker IPC, verify the returned identity against the parent's expected policy, and exclude credentials/PEM from public results.
6. Integrate the connector into the production proxy without losing connection reservation, bounded startup buffering, backpressure or raw/TLS close ownership during an asynchronous handshake.
7. Emit schema 3 and explicit protocol/transport on every new outcome, including setup/error/incomplete outcomes; propagate across explore/replay/minimize.
8. Add CLI CA/TLS input, doctor output and consistent early rejection. Snapshot a CA file once; later file replacement must not silently change cleanup trust.
9. Update report interpretation and migration/export documentation, then verify actual browser behavior under the required UI workflow.
10. Execute the remaining real negatives, cleanup certificate rotation, both protocol profiles, cancellation, installed archive/export/replay and declared Node/PostgreSQL matrix. Review before integration.

## Unfinished TypeORM work

### Accepted lifecycle milestone

`feature/typeorm-gate`, commit `5eb1d663c2a9a0da8087e747120acc27fa6bbd8f`, based on older `dff8a71`:

```text
examples/typeorm/connection.mjs
examples/typeorm/package.json
examples/typeorm/package-lock.json
examples/typeorm/README.md
scripts/test-typeorm.mjs
test/typeorm/lifecycle.mjs
test/typeorm/queued-scenario.mjs
```

The helper owns a per-actor DataSource/`pg` pool using public driver injection and lease callbacks. It handles late acquisition, partial initialization, checked-out client errors and undefined rejection without accessing private driver sockets or replacing application SQL.

Fourteen real checks passed on Node 22.18/PostgreSQL 16.15, with no skips. They cover normal parameterized work, SQL errors, backend termination, acquisition/queue behavior, blocked cancellation/deadline and supervised containment. Eleven direct pool records ended with zero total/idle/waiting connections; fourteen exact generated databases/backends were absent. Source and independent review were accepted for this lifecycle milestone.

Important boundary: closing a client is not PostgreSQL CancelRequest. A blocked backend may remain waiting until its blocker is released or the owned database is cleaned up. The evidence records both client settlement and eventual backend absence honestly.

Evidence is in `.local/worktrees/typeorm-gate/.local/typeorm-lifecycle/`; its 484-file index SHA-256 is `f50098459cf947556b66604ff56643e7f9e223836f2e8783d8da6f1b06c6c700`.

### Functional workflow — drafts not executed

Three untracked drafts remain:

```text
examples/typeorm/scenario.mjs
scripts/test-typeorm-functional.mjs
test/typeorm/functional.mjs
```

Intended coverage: EntitySchema CRUD, transaction commit, deliberate 23505 rollback and recovery, forced 40001 with whole-transaction retry versus unhandled actor error, unsafe counter exact replay/minimization, helper source drift and original archive export/offline replay.

The scenario intentionally still lacks retry behavior so a real failing acceptance can precede implementation. Schedule assumptions in the drafted tests have not executed.

The last attempt failed before npm installation because the entry script constructed `npm-cli.js` under the toolchain's `bin/node_modules` directory. **Zero new functional/application commands ran; this was not the intended retry RED.** The wrapper's own zero exit means it observed the expected child failure and completed cleanup. Its owned server was removed and exact-ID absence recorded.

On resumption, resolve the existing Node toolchain's actual npm launcher, preserve the failed attempt, and use a fresh evidence directory. Then get the real retry RED, implement whole-transaction retry, prove fresh reads/rollback and direct invariant-skipping observation, and complete the installed workflow on PostgreSQL 16 before extending to 17/18.

TypeORM is pinned to 1.1.1 with `pg` 8.23.0. This TypeORM version excludes Node 24.7; its Node 24 range starts at 24.11. Do not silently skip the engine requirement or claim current Node 24.7 coverage. Any newer Node toolchain needs its own provenance and actual verification.

An older minimal TypeORM record/export/offline gate passed with a different helper and older runtime. Keep it as evidence for that exact input; it does not qualify the new lifecycle helper's full functional workflow.

Handoff: `.local/worktrees/typeorm-gate/.local/typeorm-functional/PAUSED-HANDOFF.md`; 58-file pause index: `PAUSED-INDEX.json`. README functional claims, CI proposal, final qualification/review and integration remain unfinished.

## Full remaining roadmap

This is an open roadmap, not a feature freeze. The sequence below reflects dependencies and available evidence. It does not remove ambitions outside PostgreSQL or pretend that every item has already been designed.

| Workstream | Remaining deliverable | Acceptance needed |
| --- | --- | --- |
| Complete upstream TLS | All direct clients, worker, proxy, schema, CLI, reports, export and matrix | Positive/negative real transport tests; identity drift; failure/cleanup; installed workflow; independent review |
| Complete TypeORM | Functional/retry/portable workflow and supported runtime/server rows | Actual transaction behavior, source drift, original export/replay, resource absence and truthful docs |
| Prisma | Separate pinned generation toolchain and genuine generated runtime consumer | Original generated output, engine/lifecycle/source identity, actual install/import/query/replay/export; no guard relaxation |
| Other PostgreSQL clients/ORMs | Expand named profiles where adoption needs justify them | CRUD, prepared values, errors, transactions/retries, pools, cancellation and packaging—not a smoke query alone |
| Hosted/restricted databases | Restricted actor roles, least-privilege setup, provider allocation and cleanup | Explicit privilege model, no accidental admin capability, dedicated provider tests and failure recovery |
| Additional authentication | Frontend TLS, mTLS, required channel binding, name overrides, token refresh | Separate threat/identity/ownership contract and actual positive/negative qualification |
| Project layouts | Workspaces, monorepos and additional package managers | Original lock/resolution graph, source drift, archive identity and unchanged portable installation |
| Extensions | Composable closed fixture profiles | Extension/version/schema/value identity and drift checks; no silent widening of the native profile |
| Operating systems | Native Windows ownership/interruptions and automated macOS qualification | Actual package/CLI/process cleanup and consumer journeys on declared targets |
| External-language actors | Language-neutral actor process protocol and first pinned foreign runtime | Source/dependency/runtime identity, endpoint injection, IPC limits, cancellation and portable replay |
| Multiple actor sessions | Stable attribution and scheduling of concurrent connections | Versioned choices/replay, pool/session lifetime, wait semantics and resource ceilings |
| Additional protocol features | COPY/bulk, cursors, CancelRequest and further prepared/pipeline behavior | Independent protocol profiles, exact bytes, scheduling boundaries and failure/cleanup tests |
| Other database engines | Select first concrete engine and design its native mechanism | Own protocol, fixture, scheduler, transaction/wait and replay contracts; PostgreSQL wire similarity is insufficient |
| Real historical cases | Three independent bugs and their actual fixes with retained business logic | Pinned provenance/licenses, valid reproductions, repaired outcomes, portable regression and honest misses |
| Comparisons | Ordinary concurrency, manual barriers and PostgreSQL isolation baselines | Same declared tasks, measured setup/replay/reduction, failure counts and limitations |
| Usability | Unaided first-user installation-to-regression exercise | Actual participants and observed confusion/completion; no invented outcomes |
| Documentation | Reconcile all new support rows, migration, examples and troubleshooting | Executed commands from the final installed package; clear unsupported paths and accessible reports |
| Release/discovery | Stable package/release, authentic demo, project metadata and factual launch material | Final source attestation, public download verification, working links and permitted account access |

Known Prisma preparation constraints: the researched 7.10.0 client archive is larger than the current default 64 MiB individual archive bound, and generation/engine lifecycle scripts do not fit the existing shared export profile. No Prisma install/generation was performed. Resolve architecture and actual runtime packaging before advertising support; do not loosen integrity or size bounds merely to make one example pass.

Some items require product design before implementation, particularly non-PostgreSQL engines, foreign runtimes and multi-session scheduling. Their acceptance criteria must be made concrete when taken up. The earlier 2–4-day estimate depended on a narrower near-term release assumption; it is not a reliable deadline for this entire open roadmap.

## Release and distribution gates

### What is already public

The development repository and qualified main source are public. README, reference docs, examples, license, security/contribution guidance, issue templates, CI and release preparation tooling exist. Canonical archives and detailed local evidence have been prepared; preparation is not publication.

### What remains before a finished release claim

1. Finish selected implementation work and resolve material review findings without merging partial failing branches.
2. Reconcile original acceptance gates with the expanded roadmap explicitly. The user has not waived the historical/comparison work or approved a feature freeze.
3. Update version, changelog, README/support matrix, examples and migration guidance around the actual final implementation.
4. Run the required matrix on the exact final source; record source/Node/PostgreSQL/driver/extension identities and every failure or skip.
5. Build new canonical assets from that exact source. Preserve all earlier assets. Inspect real archive content, license notices and secret/private-file exclusions.
6. Install the original new archive into clean consumers and execute the documented complete journey, including original-source portable export/replay and repaired-code CI behavior.
7. Review the whole product and release evidence independently. A collection of green component suites is not sufficient on its own.
8. Publish the verified tag/GitHub release and npm package under Pavan's account when final gates and account access permit; then download the public assets and verify hashes/install/runtime behavior.
9. Attach factual demo/report assets, repository topics/description and launch documentation. Track published URLs separately from prepared copy.
10. Update this status, the continuation ledger and the validation record. Mark completion only for work actually done.

The last recorded `npm whoami` result was `E401 Unauthorized`; authentication was not rechecked during this pause. GitHub pushing was previously working. Do not claim npm publication or expose credential files. No external launch messages were sent by the pause work.

### Historical/comparison restrictions

Four existing private handoffs record stopped historical/comparative executions:

```text
.local/knex-blocked-handoff.md
.local/sequelize-blocked-handoff.md
.local/node-pg-migrate-blocked-handoff.md
.local/neveroversell-baseline-blocked-handoff.md
```

Automatic review cited possible cybersecurity risk. Do not rerun, rephrase, reroute or delegate the rejected operations. The ordinary new product fixtures used for TLS and ORM lifecycle work are separate; their success is not a replacement for the missing historical/comparative evidence.

The old baseline handoff also preserves an ambiguous container identity with cleanup unverified. This pause does not resolve that historical uncertainty and does not authorize guessing a cleanup target. Read the exact handoff before any future recovery decision. Do not say that every resource from the project's entire history is absent.

## Exact workspace and evidence map

### Worktrees to preserve

All paths below are relative to `/Users/pavan/dev/interleave`. Ignored worktrees and `.local` evidence are local; a fresh GitHub clone will not contain them.

| Worktree | Branch / HEAD at pause | State |
| --- | --- | --- |
| Main project | `main` / `3785d49` application checkpoint | Clean before this documentation checkpoint; TLS and TypeORM not integrated |
| `.local/worktrees/tls-foundation` | `feature/tls-foundation` / `1251dec` | Committed internal resolver milestone |
| `.local/worktrees/tls-fixture` | `feature/tls-fixture` / `875111e` | Committed fixture milestone |
| `.local/worktrees/tls-connector` | `feature/tls-connector` / `64a5727` | Three untracked source/test files; paused copies retained |
| `.local/worktrees/tls-artifact` | `feature/tls-artifact` / `1251dec` | Five tracked modifications plus one new test; paused diff/copies retained |
| `.local/worktrees/upstream-tls` | `feature/upstream-tls` / `1cc9a02` | New failing database TLS test plus an untracked install log; no lifecycle production changes |
| `.local/worktrees/typeorm-gate` | `feature/typeorm-gate` / `5eb1d66` | Committed lifecycle helper plus three untracked functional drafts |

TLS fixture commits are already cherry-picked into connector and root integration worktrees under different hashes. Do not apply them twice. TypeORM's base predates current main; reconcile integration against current source rather than assuming it already includes later fixes.

Older worktrees remain for adopted documentation, report inclusion, managed database, ordinary ORM, shared export, exploration, Describe/Flush, report overwrite and pgvector milestones. A retained older worktree is not automatically pending work. A detached historical baseline worktree also remains; its stop restrictions still apply. The machine-readable pause inventory records every worktree so none needs to be guessed.

### Where to find the detailed evidence

| Path | Purpose |
| --- | --- |
| `.local/CURRENT.md` | Authoritative short continuation ledger; supersedes stale chronological checkpoint text |
| `.local/history/` | Earlier ledgers preserved before replacement |
| `.local/pauses/2026-09-25/` | Read-only pause inventory, copied dirty files, diffs and SHA-256 manifest |
| `.local/expansion/BRIEF.md` | Original broad-adoption expansion order; latest pause instruction supersedes its old pending-question text |
| `.local/expansion/compatibility-audit.md` | Concrete compatibility gaps found in code |
| `.local/expansion/onboarding-docs-audit.md` | Original onboarding issues and requirements |
| `.local/expansion/inclusive-report-audit.md` | Original inclusion/accessibility findings |
| `.local/expansion/integrated/` | Integrated source checks, package regressions, CI snapshots and narrow timeout correction |
| `.local/expansion/candidate-3785d49/` | Immutable original candidate archive/source/manifest |
| `.local/expansion/consumer-acceptance/` | Final two-toolchain consumer results, index and preserved failed attempts |
| `.local/expansion/tls-foundation/` | Resolver handoff, decisions, reviewed diff and verification |
| `.local/expansion/tls-connector/` | Connector pause handoff, source copies, tests and exact cleanup evidence |
| `.local/worktrees/tls-artifact/.local/tls-artifact/` | Schema plan/diff/index, focused success and all 61 full-suite failures |
| `.local/worktrees/upstream-tls/.local/` | Root direct-client build and meaningful failing test log |
| `.local/worktrees/tls-fixture/.local/` | Fixture plan/review, failures and final 18-check result |
| `.local/worktrees/typeorm-gate/.local/typeorm-lifecycle/` | Accepted helper source and 14-check lifecycle evidence |
| `.local/worktrees/typeorm-gate/.local/typeorm-functional/` | Functional drafts, failed pre-install attempt and pause handoff/index |
| `.local/expansion/prisma-typeorm-plan.md` | Original package/runtime design constraints |
| `.local/release-publication-plan.md` | Publication workflow design; early recorded CI details are historical, not the current job count |
| `docs/qualification/` | Public dated qualification notes, each bound to its stated source |

Research origin: `/Users/pavan/dev/oss-bets-2026-09/04-interleave.md`, the complete research folder, and the referenced **OSS RESEARCH GPT** conversation (`01a075e0-49d6-7790-8a35-601881002148`). The original deep audit is already complete. Consult specific source material when needed; do not repeat the entire audit as a substitute for continuing implementation.

### Toolchains and resources at pause

- Node 24.7.0: `/opt/homebrew/Cellar/node/24.7.0/bin/node`; npm 11.5.1.
- Node 22.18.0: `.local/toolchains/node22-qualification/node-v22.18.0-darwin-arm64/bin/node`; npm 10.9.3.
- Docker 28.3.3 was available during the work; the current local official PostgreSQL 16 fixture image produced 16.15.
- The context-mode JavaScript runtime is Bun. `process.execPath` inside it is not the qualified Node binary. Use an explicit verified Node path for Node test commands.
- Existing development server `interleave-dev-pg16`, ID `74a3ecec988cfad3df8011ec8325fd99a254ae34ba0051bddb76442670e98bbe`, port 65064 / PostgreSQL 16.13 was preserved. It is not a pause-cleanup target.
- All three active workstreams reported their running commands settled and their current owned test resources cleaned. No product execution session remains active for this pause. Historical baseline uncertainty is separately retained above.
- No background continuation or scheduled resumption has been requested. Wait for Pavan's next instruction.

## Resume sequence

1. Read this document and `.local/CURRENT.md`. Confirm the user has resumed work. Preserve the open roadmap and do not ask the already-rejected feature-freeze question again.
2. Read `AGENTS.md`, `PRODUCT.md`, the specification and the plan for the work being changed. Check current git state before touching any branch.
3. Verify the pause inventory against the surviving worktrees. Preserve untracked drafts and raw evidence; never run a broad clean/reset over `.local`.
4. Continue root TLS integration from the existing direct-client RED. Reuse the accepted resolver/fixture; coordinate type-file ownership with the schema changes.
5. Review and finish the connector and schema drafts in parallel where independent. Resolve known schema fixture failures as part of real runtime migration, not by weakening the contract.
6. Resume TypeORM by fixing the private runner's npm-path assumption, then obtain the intended real retry failure and complete the functional gate. Reuse the existing 14-check milestone unless helper changes justify rerunning it.
7. Integrate only reviewed coherent changes. Run targeted real checks first, then the affected full suites and declared matrix. Preserve all failed attempts and qualify exact source identities.
8. Reconcile compatibility docs and new consumer qualification with main. Prepare new assets only after source changes require them; never overwrite `candidate-3785d49`.
9. Advance the next concrete workstream from the full roadmap. Keep unsupported/unrun rows visible and make its acceptance criteria explicit before claiming support.
10. Continue release/research/publication gates within existing authorization and actual tool/account constraints. Keep stopped operations stopped unless their original restriction is properly resolved.
11. Update memory after milestones and before compaction; keep the user-facing status document current at meaningful checkpoints.

## Working agreements and continuity

- Pavan delegates technical decisions and wants completion, thorough tests, excellent documentation and a broadly useful open-source project. Routine choices should not repeatedly turn into permission questions.
- All commits/pushes use Pavan's account and repository-local identity. Preserve third-party licensing and provenance; do not add irrelevant contributor trailers or unsupported authorship claims.
- This pause authorizes documentation and preservation, not continued feature work. No partial branch is ready to merge merely because the session is ending.
- For any future user-facing UI work, use Impeccable first, then applicable baseline, accessibility, motion and metadata checklists. Apply the project's verification rules; do not silently install new UI instrumentation.
- Read instruction files in full through the normal file/shell tools. Use bounded analysis tools for bulky logs and datasets. Keep raw evidence on disk.
- Test claims identify the exact source, runtime, database/profile and workflow. Focused/component success and full product success are different claims.
- Preserve failed runs, original artifacts, original locked archives and source identities. New checks belong in new evidence directories.
- Never claim all scenarios are tested, a framework universally supported, or a project complete because the remaining work is large or time is running out.
- At every handoff, record what changed, what passed, what failed, what did not run, dirty files, remaining resources, next concrete steps and unresolved decisions.

**Resume without restarting:** the repository, source, branch work, tests and original evidence are preserved. The next session should continue from the specific unfinished steps above.
