# Managed local PostgreSQL implementation plan

> **For agentic workers:** Use the subagent-driven-development or executing-plans workflow, with failing behavior tests before production changes and independent review before integration.

**Goal:** Let a developer run the existing database CLI workflow using an automatically provisioned, exactly owned local PostgreSQL container, without manually constructing an administrator URL.

**Architecture:** An internal CLI lifecycle module supplies one fresh server URL to an existing command callback and verifies removal in finally. The scheduler, database-per-execution contract, wire profiles and artifact schema remain unchanged. The explicit administrator-URL route remains available.

**Tech stack:** Existing Node.js 22.18+/24 TypeScript, Docker CLI, pg 8.23.0, Vitest and actual PostgreSQL. No production dependency is added.

**Spec:** This document defines the complete bounded subsystem under the broader `.local/expansion/BRIEF.md`. The existing `docs/architecture/specification.md` remains authoritative for execution and evidence.

## User-visible contract

- `--docker` is an explicit boolean on `demo`, `doctor`, `run`, `replay` and `minimize`. `report`, `export` and `init` never start a server.
- `--postgres-image` requires `--docker`. Accept exactly `postgres:16`, `postgres:17`, `postgres:18`, and `pgvector/pgvector:0.8.6-pg17-bookworm`. Default is postgres:16 for native, the vector image for the existing explicit vector fixture profile. An explicitly incompatible vector-profile/native-image combination is rejected before Docker.
- `--docker` rejects an explicit `--database-url` or non-empty `TEST_DATABASE_URL` rather than ambiguously selecting a server. Existing commands without `--docker` preserve their current URL behavior. Help/version do not contact Docker.
- Each command invocation creates one randomly named and labeled container, loopback-only random port, random password supplied only through the child environment. Each application execution still creates and removes its own uniquely generated database inside it.
- Docker progress goes to stderr only. `--json` stdout remains a single command result or error object. No database password/URL is printed, placed in process arguments, or placed in ownership metadata.
- The first image download is allowed and clearly described. A missing/unavailable Docker engine produces an actionable error, with the dedicated-server alternative.
- Creation/start/readiness/command/removal are bounded. Interrupts abort application work, retain its recorded outcome, and await owned-server cleanup. SIGINT/SIGTERM preserve 130/143 precedence. A failed/uncertain container cleanup is never reported as success, and identifies the exact owned name for diagnosis.
- The command result is emitted only after container cleanup succeeds. A saved application artifact remains application database evidence; it is not silently relabeled as proof of container cleanup.
- No automatic browser opening, persistent Docker service, arbitrary external image, application database reset, provider or Windows support claim is introduced.

## Lifecycle boundary

Create `src/cli/managed-postgres.ts` with this internal interface:

```ts
export interface ManagedPostgresOptions {
  image: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
export async function withManagedPostgres<T>(
  options: ManagedPostgresOptions,
  use: (databaseUrl: string) => Promise<T>,
): Promise<T>;
```

Production command execution uses argument arrays, bounded output, and no shell. Keep the Docker boundary small enough to exercise failed daemon replies without mocking PostgreSQL or the scheduler. An internal dependency-injection seam or a test-owned fake Docker executable is acceptable for control-plane failures, but actual success and database semantics require the real daemon/server.

Ownership consists of unpredictable owner label, exact name, exact full container ID once known, and inspected image ID. Capture ownership before start. If a create reply is lost/invalid, recover only the exact proposed name with matching labels; never remove a name collision. At cleanup inspect the exact ID/name/labels/image again, refuse mismatch, remove only that exact ID with its volumes, and verify actual NoSuchObject/NoSuchContainer. Daemon failure is not absence.

Readiness requires the final official entrypoint-complete marker plus a real successful version query; an initialization server's temporary health is not sufficient. Preserve the primary failure and any cleanup failure. Never print arbitrary Docker output that could contain credentials. Do not mutate the existing test harness just to share code in this first subsystem.

## Task 1: option contract and managed lifecycle

**Files:** create `src/cli/managed-postgres.ts`, `test/cli-managed-postgres.test.ts`; modify `src/cli/options.ts`, `test/cli.test.ts`. Production entry remains internal, not a new public library export.

- [ ] Add option tests first. Representative independent expectations:

```ts
expect(parseCliArgs(['doctor', '--docker']).values.docker).toBe(true);
expect(() => parseCliArgs(['report', 'run.json', '--docker'])).toThrow(/not supported/);
expect(() => parseCliArgs(['doctor', '--postgres-image', 'postgres:17'])).toThrow(/requires --docker/);
expect(() => parseCliArgs(['doctor', '--docker', '--postgres-image', 'unqualified:image'])).toThrow();
```

- [ ] Record the actual failing test against the original parser before implementing flags and validation.
- [ ] Add lifecycle tests at the Docker boundary before implementation: missing executable/engine; invalid create reply with owned recovery; name collision; interruption after successful creation; invalid non-loopback port; initialization-only readiness; exact ownership mismatch; failed removal; daemon error versus genuine absence; callback failure and cleanup failure together. Assertions cover no application callback before readiness, exact retained ownership, refusal to touch a foreign ID, and propagated outcome, rather than only call counts.
- [ ] Implement bounded lifecycle and run the focused tests. Use actual selected Docker JSON shapes, not partial invented inspect data. Verify password is absent from arguments/progress/returned error strings.

## Task 2: integrate existing commands and diagnostics

**Files:** modify `src/cli.ts`, `src/cli/options.ts`; create/modify relevant CLI tests, and `src/cli/init.ts` only for accurate next steps. Check `src/source-identity.ts` and release file inventory if they explicitly enumerate runtime helpers.

- [ ] Make database execution return its result/code to the outer lifecycle, emitting stdout only after cleanup. Existing non-Docker command behavior and artifact overwrite semantics must stay unchanged.
- [ ] Prove `--docker`/URL conflicts fail before any command or daemon call. Prove report/export/init/help/version stay independent of Docker.
- [ ] Add doctor human output for the actual recorded Node/Postgres versions and fixture profile; test actual output against the real result rather than a made-up example. Keep JSON unchanged.
- [ ] Document both valid scaffold routes: `npm run race -- --docker` and a dedicated `TEST_DATABASE_URL`. Show `npm run race -- --docker --force` for intentional replacement; never suggest duplicate `--out`. Add report next step. No installation is performed by init.
- [ ] Run focused CLI/init/source-identity checks, typecheck and build. Any new built runtime helper must be included in exact runtime identity and package content checks.

## Task 3: real Docker and installed-command acceptance

**Files:** create a dedicated managed-CLI integration test/runner and a qualification note, using existing ordinary owned scenarios only. Keep native non-Docker unit tests runnable without Docker; make Docker qualification explicit and mandatory for the advertised managed path.

- [ ] With no database URL, run actual managed doctor; assert exact recorded versions, two real parameterized commands, cleanup, and daemon absence of the exact created container.
- [ ] Run actual managed unsafe and safe packaged demonstrations; inspect invariant, trace and CLI exits 1/0 respectively, not just process completion. The demo is a constructed example, not a historical comparison.
- [ ] Record an ordinary file application, exact replay, minimize and report using separate managed invocations. Check source/fixture/failure identity and real SQL preserved across fresh servers; reject incompatible image/profile explicitly. Keep original artifacts immutable.
- [ ] Interrupt a real owned command after server readiness and verify expected signal exit and exact container absence. Exercise callback/output error cleanup. Never delete unrelated containers or databases.
- [ ] Qualify built installed archive behavior after integration, preserving exact source/archive identity. Do not transfer f66 acceptance to changed source. Add appropriate CI job/selection for managed Docker tests and require it to pass.

## Task 4: newcomer documentation and review

**Files:** README, CLI/init docs, getting-started/troubleshooting guide and current support summary, coordinated with the documentation task.

- [ ] Lead with a real report-producing checkout recipe using `--docker`, exact working directory, expected violation exit and output names. Retain the existing dedicated-server route and first-download explanation.
- [ ] Review new literal commands and run them from the newly installed package. Existing f66 evidence remains historical, unchanged.
- [ ] Independent source review covers signal/ownership/readiness/cleanup/JSON/credential boundaries and all new test evidence. Fix material findings before integration.
- [ ] Integrate with Pavan author/committer, run required updated CI and candidate workflows, and update durable memory. Mark only this managed subsystem complete; broader compatibility, historical studies and publication remain open.
