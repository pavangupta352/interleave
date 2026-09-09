# Interleave product and engineering specification

Status: implementation contract, 8 September 2026. This document describes required behavior, not a list of already shipped features.

## Outcome

A developer supplies existing concurrent application operations, disposable database setup and an invariant. Interleave finds an ordering that violates the invariant, explains it, reduces the ordering instructions while preserving that same failure, and exports a regression fixture runnable from a clean checkout. A repaired file application is evaluated with a clearly labeled guided rerun and fresh exploration. Exact file replay requires the recorded source, installed dependencies, runtime, fixture and query contract to match.

The complete release includes a library, CLI, isolated database lifecycle, real wire proxy, scheduler, explorer, replay, reduction, artifact validation/export, visual report, documentation, working portfolio integrations, CI and measured qualification. Working demonstrations alone do not establish the broader historical-bug validation gate.

## Choice of mechanism

Use a transparent PostgreSQL protocol proxy implemented in TypeScript. A driver wrapper would be easier but would constrain application integrations and risk changing query semantics. A simulated database would offer stronger determinism but would test a different execution engine. The proxy keeps real queries and results while explicitly limiting scheduling to protocol boundaries.

Node.js 22.18+ and 24 are release qualification targets. PostgreSQL 16, 17 and 18 are database qualification targets; any version untested at publication remains unsupported. The primary driver is node-postgres. Postgres.js and ORM paths using the qualified drivers are expansion acceptance targets, with their exact versions recorded.

## Scenario contract

`defineScenario({name, setup, actors, invariant})` returns a validated scenario. `setup({db, connectionString})` creates schema and deterministic initial data in an empty disposable database. `actors` is a record of at least two named async functions receiving `{connectionString, actor, signal}`. Applications construct their existing driver/client/pool from this endpoint. Actor functions close their owned connections in finally blocks. They may return serializable observations. `invariant({db, results})` throws an assertion with a stable failure identity or returns successfully. Result records distinguish fulfilled from rejected operations.

The first actor profile supports one simultaneous physical connection per actor, including a pool configured with maximum one connection. An explicit auxiliary profile permits up to eight live physical connections while retaining exactly one live command-producing session per actor. Queryless monitoring sessions remain separately identified. A competing live command producer is an explicit unsupported-profile error. Sequential reconnects carry an increasing connection generation in evidence. Actor-specific endpoints identify operations without SQL comments or rewriting business logic. One shared pool used by several request actors is not silently treated as stable identity.

`explore(scenario, options)` takes an explicit admin database URL, maximum runs, steps, overall/individual-run deadlines and optional seed/strategy. `runOnce` executes a supplied partial actor plan with deterministic fallback. `replay` validates and consumes an entire recorded schedule. `minimize` repeatedly executes reduced ordering instructions and retains only the same invariant failure. API outcomes must remain serializable.

## Disposable database lifecycle

Create a uniquely named database for each execution using an explicit administrator connection. The generated name must start with `interleave_` and contain only generated hexadecimal suffixes. All actor URLs, setup and assertions target that database. Never reset tables or terminate sessions in a caller's existing application database. Cleanup closes proxy sockets, actor clients under the harness's ownership, monitor connections, and terminates remaining connections only in the exact generated database before dropping it. Cleanup errors are retained. Setup and invariant queries bypass scheduling and run outside the actor window.

Support a user-managed disposable database profile only with an explicit destructive-reset contract and ownership checks; this is separately documented and tested before enabling. Initial convenience paths use an isolated task-owned Docker Postgres instance or a supplied admin URL. Loopback endpoints bind to 127.0.0.1 with random free ports.

## Proxy semantics

Forward exact frontend packets and exact backend responses. Do not execute captured SQL through another driver. Do not parse SQL to split batches or recreate bind parameters. Length-framed parsers enforce maximum message and buffered-byte limits and handle arbitrary TCP fragmentation/coalescing.

Startup v3, authentication, parameters, backend key, notices and errors pass through. Frontend TLS/GSS negotiation must be explicit: plaintext-inspecting profile responds unavailable; a client requiring TLS receives an actionable unsupported-profile result. Upstream TLS termination is a future separately qualified transport profile, not implied by localhost operation.

Scheduling units are an entire Simple Query packet, or an ordinary extended cycle through Sync. Buffer the entire extended cycle before forwarding any Parse/Bind/Describe/Execute, because planning/binding may already acquire locks. Track prepared names and portal associations for descriptions and identity without altering packets. ReadyForQuery closes a unit and records transaction state. CommandComplete, SQLSTATE and row counts provide result summaries. Full row values and parameter values are private by default; portable raw artifacts explicitly document what they include. Query text itself may contain literals.

Streaming COPY, logical replication, early Flush-dependent extended flows and other unqualified protocol modes fail closed with a named unsupported outcome, never an infinite wait or silently changed query. Standard queued cycles can be buffered, but opt-in pipeline profiles require tests before claiming support. Cancellation must not misroute a backend key; unsupported cancellation routes are clearly rejected until a correctly qualified forwarding path exists.

## Scheduling and waits

The scheduler waits for a queued head unit, a completed actor, or an observed blocked in-flight unit from every active actor before making a choice. Choose one available actor, forward one whole unit and wait for completion. If it has not completed, inspect the actual server's activity using a separate monitor connection and the captured backend PID. `pg_blocking_pids` plus activity state identify actual lock blockers. An elapsed delay is never classified as a lock.

Only a confirmed lock wait permits another actor's unit to release while that unit is still running. Record blocked statement, blocker PIDs/actors, wait event and observation sequence. PostgreSQL controls when an unblocked backend resumes. The proxy controls releases, not exact backend completion order. Unexpected outside blockers, readiness timeouts, step/run limits, client disconnects and unsupported protocol are separate inconclusive or harness outcomes.

Deadlocks and serialization errors remain real PostgreSQL outcomes, with SQLSTATE preserved. Tests may handle them in existing application retry logic. An unhandled actor error is never automatically reported as an application invariant failure. Final invariant checks occur only after actors settle and scheduled work completes.

## Exploration

Explore bounded actor-choice prefixes derived from observed choices, retaining per-actor program order. Use an initial fair schedule for fast discovery and a deterministic search of alternatives. Store seed/strategy, completed runs, attempted runs, remaining frontier, depth, steps, context switches and budget-stop reason. Skip duplicate prefixes. Invalid prefixes are infeasible, not passing executions. A completed bounded search reports its model and bounds; it never proves absence of every application race.

## Replay and reduction

Versioned replay records contain scenario identity, stable actor IDs, connection generation, actor-local ordinal, wire-protocol kind, exact SQL fingerprint, parameter/payload fingerprint where available, transaction state, observed wait requirements and environment metadata. Harness-managed authentication exchanges and backend cancellation keys are never recorded. Verbatim application SQL, selected observations, and messages can contain sensitive data, including credentials; private raw evidence and explicitly redacted sharing copies have separate contracts. Redaction must never silently change evidence presented as an exact replay source. Validate all artifact fields and resource limits before use.

Strict replay verifies every next query and every consumed step, rejecting missing/extra/changed queries and changed actors as incompatible. Strict matching must not normalize away literals or SQL clauses. Environmental differences are detected and reported before execution when they affect the contract; no silent fallback to exploration. A source, dependency, fixture or query change after a fix uses an explicit guided mode, retaining actor-order hints while producing a new trace and labeling it as a different execution.

Reduction removes ordering instructions, never application statements or fixture setup. Test candidates in fresh databases and retain only the same invariant failure fingerprint. Respect reduction budgets and report attempts, removed instructions, local minimality scope and untested candidates. Export the exact final execution alongside the reduced instructions, so a claim of preservation is backed by a successful fresh run.

## Artifacts and explanation

Use a versioned JSON manifest for machine consumption and a standalone HTML report with no network dependencies for inspection. Export a regression package with scenario source explicitly selected by the user, dependency lock, setup and replay instructions, recorded environment, hashes and an integrity manifest. Reject traversal, symlinks outside the selected source root, executable auto-run instructions in imported manifests, oversized payloads, and corrupted integrity records. Import never executes scenario code merely by opening a report.

The visual viewer shows the actual outcome first, actor columns, released statements, completions, observed waits and invariant evidence. Selecting a step reveals SQL, protocol, transaction status and verified result/error summaries. Keyboard controls, text alternatives and copy/download work offline. A sample view is clearly labeled as a recorded example. Loading a local report must validate it, and failure states must be usable.

## Qualification and launch

Test framing and malformed input; real simple/parameterized/prepared query forwarding; transactions/rollbacks; errors/notices; actor completion/reconnect/pool limits; lost-update, duplicate-claim, write-skew and deadlock cases; waits distinguished from slow queries; replay mismatch and drift; budgets; cleanup after failures/signals; reduction failure identity; artifact injection and packaging; API/CLI installed-package use; offline report operation and accessibility.

Use neveroversell's exact unsafe application source with gapMs=0 and its production reservation API as an owned example. Test pghybrid's real supported adapters without making it a core dependency. Preserve source pins, licensing and claims boundaries. Qualify three independent historical real-application defects without rewriting their business logic, alongside ordinary concurrent, manual barrier and PostgreSQL isolation-test baselines. Record setup effort and measured replay/reduction/runtime results. Independent user outcomes require actual participants; they are not fabricated or inferred from automated checks.

Publish under pavangupta352 with Pavan Gupta's author identity. Supply MIT license for original code, contributing/security/conduct docs, issue templates, CI, compatibility/limitations, architecture and troubleshooting docs, authentic demo assets, a release with checksums, install verification and evidence-based launch copy. Do not create irrelevant contributor trailers. Build quality and discovery preparation are controllable; future stars and viral spread are not release facts.
