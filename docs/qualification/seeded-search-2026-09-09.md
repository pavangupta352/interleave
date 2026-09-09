# Seeded exploration and search metrics — 2026-09-09

This qualification covers optional seeded selection of pending actor-choice
prefixes and aggregate search metrics. The default FIFO selection, candidate
generation, actor fallback, replay contract and resource limits remain intact.
The [API guide](../api.md#search-selection-and-measurements) specifies the
versioned selection algorithm and metric definitions.

## Actual search and replay

On Node.js 24.7.0 and PostgreSQL 16.13, seed `2` first executed the supplied
serial plan `a,a,b,b`, which passed. It then selected prefix `b`; the actual
`b,a,b,a` release order exposed a lost update in the constructed counter fixture.
The returned summary recorded:

| Measurement | Observed value |
| --- | ---: |
| Attempted runs | 2 |
| Completed runs | 2 |
| Maximum attempted prefix depth | 4 |
| Recorded release units | 8 |
| Within-run actor switches | 4 |
| Trace counts complete | true |

The violating run was serialized, parsed and exactly replayed against a fresh
database. Fixture, query and failure identities matched. All three generated
database names were distinct, and an independent administrator query confirmed
that none remained. This is a programmatic scenario qualification, not a
historical application defect or exported regression bundle.

## Validation

The focused search selection passed 60 tests across three files in 9.92 seconds.
It covered unchanged default order, pinned seeded sequences including zero and
the largest uint32 seed, invalid selection before execution, removal of search
options before runner dispatch, infeasible plans, cancellation and resource
ceilings. Metrics checks included stage and batch counts, reconnects, completed
actor errors, omitted valid artifacts, invalid evidence, partial traces and
failed cleanup. Independent review found no open core issues after two additional
cases isolated the cleanup and completion guards.

CLI argument checks passed 26 cases. Three real CLI checks passed in 4.71 seconds:
seed-zero discovery and retained-artifact exact replay, human completion counts,
and a step-limited run whose trace counts are explicitly labeled lower bounds.
The search summary contains the seed and metrics; its saved replay artifact
remains a RunResult without those search-only fields. Independent CLI and
documentation review found no material issues.

Final local integration passed build and type checks, **654 native tests in
50 files** (117.13 seconds), and the separate **ten pgvector tests in three
files** (4.73 seconds), including the installed pghybrid CLI and exact replay.
The vector checks used PostgreSQL 17.11 with pgvector 0.8.6 and removed their
exact owned container. Timings describe these runs, not comparative performance.

At commit `8f273e5b4b55e99d57cb7d557a18b9d40e471499`, the
[CI run](https://github.com/pavangupta352/interleave/actions/runs/34318463204)
passed all nine jobs: PostgreSQL 16/17/18 on Node.js 22.18.0 and 24.7.0,
two PostgreSQL 17 / pgvector 0.8.6 jobs, and desktop/mobile report checks in
Chromium, Firefox and WebKit. This qualifies that development commit, not a
published stable package.

## Boundaries

A seed controls which pending prefix is selected when observations match. It
does not freeze external effects, statement internals, lock resumption or
elapsed-time budget cutoffs. Selection is not uniform random sampling, and a
passing bounded search is not proof of race freedom. Exact replay consumes the
recorded execution rather than a seed.

Recorded release units are not SQL-statement, affected-row or confirmed server
execution counts. Partial evidence makes trace counts lower bounds, including
when evidence limits remove trace details. Valid artifacts omitted solely from
search retention still contribute their measured counts.

The existing per-run deadline also bounds actor readiness. This change introduces
no independent readiness timer and does not alter worker, protocol, artifact,
replay or reduction behavior.
