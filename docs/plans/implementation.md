# Interleave implementation plan

**Goal:** Deliver the complete real-Postgres race discovery, explanation and regression workflow described by the [specification](../architecture/specification.md).

**Architecture:** A TypeScript library owns disposable databases, stable actor endpoints and a transparent wire proxy. A scheduler chooses protocol-unit release orders while PostgreSQL executes the actual work; exploration, strict replay and reduction use the same runner. Versioned artifacts feed the CLI and offline visual report.

**Tech stack:** Node.js 22.18+/24, TypeScript, node-postgres, real PostgreSQL, Node's network/crypto/filesystem APIs, Vitest, browser tests.

**Execution:** Test-driven independent modules with shared interfaces, integration tests and independent review. The private progress ledger records evidence, decisions and unfinished gates across sessions. A task is complete only after its required behavior passes and material review findings are addressed.

## Global constraints

- Execute actual application queries against actual PostgreSQL; never replace the DB with a simulator.
- Forward original protocol bytes; Simple Query batches and extended cycles are indivisible units.
- Never call elapsed delay a database lock; require server observations.
- Create/reset/drop only uniquely generated task-owned databases, with explicit admin connection.
- Separate invariant failures, actor errors, unsupported profiles, incompatible replay and inconclusive runs.
- Preserve stable actor identity, exact query identity, budgets and uncertainty in every report.
- Use Pavan Gupta <pavan.gupta.352@gmail.com>; public repository pavangupta352/interleave; package @pavangupta352/interleave.
- Preserve third-party license notices and source provenance. Do not add irrelevant contributor trailers or invented claims.
- Update private continuation memory after each verified milestone and before context transitions.

## Acceptance tasks

### 1. Protocol and proxy

Files: `src/protocol/{framing,frontend,backend}.ts`, `src/proxy.ts`, `test/protocol.test.ts`, `test/proxy.integration.test.ts`.

Interface: `createProxy({upstreamUrl, actor, onUnit, onEvent, onError}) -> Promise<ActorProxy>`; proxy exposes `connectionString`, `close()`. A `PendingUnit` exposes `{actor, connection, ordinal, protocol, sql, fingerprint, backendPid, release():Promise<UnitCompletion>}`; release sends the retained original packets once. Error callbacks never throw into socket event emitters. Completion reports transaction status, command tags, row count and SQLSTATE; backend keys never enter serialized events.

- [x] Write a failing byte-fragmentation test with two hand-authored frames; assert exactly one event per complete packet and malformed-length rejection. Implement bounded framing.
- [x] Write failing frontend tests for Q and Parse/Bind/Describe/Execute/Sync; assert original bytes survive and statements map to the correct prepared/portal identities. Implement cycle assembly.
- [x] Write failing real-Postgres proxy tests that prove a query has not reached the server until release; then check exact parameterized, binary/null, prepared, rollback and error results after release. Implement transport/auth/lifecycle.
- [x] Exercise TLS-required, COPY, early Flush, oversized frames, disconnect and second actor connection. Verify clear rejection, no leaked backend and no process crash.
- [x] Review this module independently before calling it qualified.

### 2. Disposable execution and scheduler

Files: `src/{types,scenario,database,scheduler,runner}.ts`, `test/{database,scheduler,runner}.integration.test.ts`, `test/helpers/postgres.ts`.

Interface: shared scenario/options/run-artifact types in `src/types.ts`; `runOnce(scenario, {databaseUrl, plan?, replay?, maxSteps?, timeoutMs?}) -> Promise<RunResult>`. `RunResult` contains outcome, failure identity if applicable, trace, choices, actor results, environment and cleanup evidence. Scheduler consumes `PendingUnit`, actor-settled events and a database wait monitor; it never invokes application SQL itself.

- [x] Test unique DB isolation by writing a sentinel into the supplied admin database and proving it survives setup, success, failure and cancellation cleanup. Implement owned DB lifecycle.
- [x] Test two existing functions reading/updating one row: force both reads before either update without sleeps and assert the real lost update. Implement actor readiness, choices and unit release.
- [x] Test an actual row-lock waiter and release the lock owner; assert server-confirmed wait evidence and eventual completion. Separately run a slow nonblocked query and assert it is never classified as blocked.
- [ ] Test stable actor-local ordering, completion/reconnect, setup error, invariant error, actor error, deadlock, run/step/readiness limits and termination cleanup.
- [x] Review scheduler semantics and prove failure categories cannot accidentally become a pass.

### 3. Exploration, strict replay and minimization

Files: `src/{explore,replay,minimize,identity}.ts`, `test/{explore,replay,minimize}.integration.test.ts`.

Interfaces: `explore(scenario, ExploreOptions) -> ExplorationResult`; `replay(scenario, RunResult, ReplayOptions) -> RunResult`; `minimize(scenario, RunResult, MinimizeOptions) -> MinimizationResult`. Every option includes an explicit database URL; every operation has bounded resources.

- [x] Start with tests proving both a known violating order and a preserving order against real DB. Explore choice prefixes; record frontier and stop reason when maxRuns is reached.
- [x] Repeatedly replay the actual captured failure; change a SQL clause/parameter/actor and prove strict mode rejects it before presenting a result as matching. Detect extra/missing tail steps.
- [x] Test guided replay separately: changed queries produce a new trace labeled guided, never exact-match success.
- [x] Add irrelevant ordering choices around a known failure. Minimize instructions in fresh databases and assert the same invariant fingerprint; prove a different thrown error is not accepted.
- [ ] Verify deterministic seeds, infeasible plans, cancellation and resource ceilings. Independent review.

### 4. Library, CLI, versioned artifacts and regression packages

Files: `src/{index,cli,artifact,export}.ts`, `test/{cli,artifact,export}.test.ts`, `package.json`, build configuration.

- [x] Design CLI commands `init`, `run`, `replay`, `minimize`, `report`, `doctor` and `demo` around the same public API; test exit statuses for every outcome and malformed option.
- [x] Validate replay schema with bounded arrays/strings and exact version handling. Reject corrupt/tampered reports, traversal and executable imports. Preserve private SQL disclosure boundaries.
- [ ] Export an explicitly selected scenario and lockfile with hashes and setup instructions; install the package in a separate directory and reproduce the original failure using the exported regression.
- [x] Verify Ctrl-C cleanup, file-write atomicity, overwrite controls, paths with spaces, help and actionable driver/protocol/DB errors.

### 5. Visual evidence explorer

Files: `src/report/*`, `docs/assets/*`, `DESIGN.md`, `.impeccable/*`, `test/browser/*`.

- [x] Complete Impeccable product/surface direction and read craft floor before UI edits; make the actor/statement/wait evidence the central interface.
- [x] Render actual versioned artifacts into a standalone HTML report with filtering, step selection, keyboard navigation, SQL/results detail, replay instructions, local-file import and download.
- [x] Browser-test real interactions, hostile SQL text, malformed imports, large traces, offline use, reduced motion and keyboard accessibility.
- [x] Inspect desktop/mobile in one batch, fix material defects, verify once, obtain independent finish review and document the built design.

### 6. Real workloads and compatibility

Files: `examples/*`, `test/compatibility/*`, `eval/*`, `docs/{compatibility,validation}.md`.

- [x] Import pinned neveroversell naiveBuy unchanged, gapMs=0; force overselling, replay, then exercise the actual safe API. Preserve license and distinguish owned demo from historical defect.
- [ ] Exercise real pghybrid queries using its qualifying adapters and record actual driver/database versions. Test pools, prepared statements, transaction errors/retries and cancellation for every advertised profile.
- [ ] Qualify PostgreSQL 16/17/18 and Node 22/24 in CI; do not expand support claims from one passing driver query.
- [ ] Pin three independent historical application bugs and their actual fixes; retain business logic. Run real regressions and compare ordinary concurrency, manual barriers and Postgres isolation baselines.
- [ ] Record repeated replay counts, durations, setup work, reduction, missed cases and harness-induced failures. Keep unrun participant studies explicitly unrun.

### 7. Hardening and public release

Files: `.github/*`, `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `docs/*`, `scripts/*`.

- [ ] Review protocol/scheduler/resource cleanup and artifact trust boundaries; resolve every material finding with a regression test.
- [ ] Build README around one executable quickstart and actual recorded failure, clear comparison, API/CLI docs, limitations and source attribution. Verify every documented command from an installed package.
- [ ] Create public GitHub repository under verified owner, configure CI and publish reviewed commits with correct author. Attach authentic demo/report assets and evidence-based launch materials.
- [ ] Release only tested source: run matrix, package content/security checks, clean install/execution, tagged-source checks and public download/hash verification.
- [ ] Publish authorized distribution surfaces supported by available accounts, with factual copy and no duplicate/spam activity; record actual publication URLs versus prepared-only materials.
- [ ] Final independent whole-product review; update continuity and validation records. Complete the goal only when required build/release gates are actually satisfied or user explicitly changes the objective.

## Current status

The engine, database lifecycle, supervised CLI/API, evidence format and offline viewer are implemented and tested on the initial PostgreSQL 16 profile. Independent reviews have driven regression fixes for protocol state, replay identity, reduction, cleanup and export. Portable source binding, export qualification, broader database/driver compatibility, historical cases and release checks remain in progress. Checked items record completed acceptance work; unchecked items remain release gates.
