# Interleave

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated implementation choice: TypeScript on Node.js, a local PostgreSQL wire proxy, a test library and CLI, and browser-readable reports. The core runs independently of the browser. Package: `@pavangupta352/interleave`; executable: `interleave`. The unscoped npm name belongs to an unrelated package.

## Users

Application developers investigating intermittent database failures, and maintainers turning known concurrency defects into regression tests. Their application already uses Postgres; they need to see a failure, understand its ordering, and retain a runnable test.

## Product Purpose

Make a database race in real application code reproducible and preventable with a regression test. Run existing concurrent operations against real Postgres, control statement release order, evaluate application invariants, and keep the evidence necessary to repeat the test.

## Positioning

The intended advantage is a complete application-testing workflow: endpoint injection, controlled real-database scheduling, explanation, reduction and regression packaging. PostgreSQL's isolation tester already explores authored SQL interleavings. Interleave does not claim to invent schedule exploration or prove that an application is race-free.

## Operating Context

Local development and CI with disposable Postgres databases. Tests define setup, named concurrent operations, and an invariant. Each operation receives a proxy connection URL. Operations retain their database driver and business logic. A report records statements, transaction status, results, observed waits, invariant outcome, environment identity and exploration limits.

## Capabilities and Constraints

Implementation targets exploration, strict replay, guided reruns after query changes, failure-preserving reduction, portable fixtures, a CLI, a programmatic API, and a visual evidence viewer. Capabilities remain planned until the validation record confirms them.

Initial protocol qualification is node-postgres with plain SQL and ordinary extended query cycles against supported real PostgreSQL versions. More drivers, pools, named prepared statements, retries and cancellation require their own executed qualification. An actor has a stable endpoint and at most one live connection in the first scheduling profile. SQL batches are indivisible, and server-side functions remain opaque. Clocks, external services and backend resumption after lock release are not controlled.

Unrelated systems are not dependencies. neveroversell supplies an owned unsafe/safe application example; pghybrid supplies a later real-library compatibility workload. Existing project code must retain its required license notices.

## Brand Commitments

Name: Interleave. Owner: Pavan Gupta. Clear, precise developer language; explain observed behavior with inspectable evidence. Documentation must not invent adoption, superiority, novelty, timing, testimonials or growth claims.

## Evidence on Hand

The September 2026 source dossier and referenced research conversation establish the problem, proposed workflow and prior art. They contain no Interleave implementation or measured benchmark. neveroversell's deliberately unsafe fixture is not a historical production bug. Public historical cases need pinned source, licensing, unchanged business logic and a verified reproduction. Release evidence and independent usability evidence are separate.

## Product Principles

- Execute actual application queries against actual PostgreSQL.
- Keep observed facts, exploration limits and uncertain outcomes visible.
- Make the failure artifact useful after the demonstration ends.
- Make setup, explanation and replay work as one complete workflow.
- Reuse related projects where their actual interfaces help; keep installation independent.

## Accessibility & Inclusion

Implementation quality target: keyboard-operable evidence navigation, readable SQL, visible focus, reduced-motion support, sufficient contrast and responsive reports. Color alone must never identify an actor or failure.
