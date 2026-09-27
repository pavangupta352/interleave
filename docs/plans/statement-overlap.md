# Statement overlap exploration

Status: implemented on the 0.2.0 branch, 27 September 2026 (`overlap: 'pairs'`,
`--overlap pairs`); see [statement overlap](../api.md#statement-overlap). Motivated
by the Knex 0.95.12 case study, where a fix that is only wrong when two statements
execute at the same instant passed every Interleave schedule, while ordinary
concurrency failed 84/100.

What changed from the draft below:

- Paired steps carry `overlap`, the index of the pair's first step, instead of a
  group number and a separate determinism field.
- Replay releases a recorded pair together and checks each command's identity; it
  skips wait and transaction-state comparison inside the pair and reports a later
  divergence as `incompatible` with a note about interleaving. There is no special
  replay outcome.
- Reduction treats a pair as one choice; it does not split a pair into a
  sequential order.
- Fair fallback never pairs. Multi-producer runs can pair two lanes, including two
  lanes of one actor (`alice#0+alice#1`).

## Problem

The scheduler releases one command unit at a time and only releases another
while a unit is running if PostgreSQL reports that the running unit is blocked
on a lock. This explores orders *between* statements. It never lets two
statements take their snapshots and run their plans concurrently, so races that
live *inside* statement execution (INSERT ... WHERE NOT EXISTS, read-then-write
in one CTE without locking, upserts without a constraint) are unreachable.

## Contract

- Opt-in exploration mode `overlap: 'pairs'` (API) / `--overlap pairs` (CLI).
  Default behavior and artifacts are unchanged.
- A new choice kind: release the head units of two actors together. Both are
  written upstream in the same event-loop turn; PostgreSQL decides how their
  execution interleaves. Completion of each unit is observed as today.
- The release rule becomes: when no running unit is unblocked, the scheduler may
  choose one unit (existing) or, in overlap mode, an unordered pair of available
  actors. Pairs are only offered when both heads are available at that instant.
- Evidence: steps released together share an `overlap` group number and record
  their individual completion order. Waits are observed per unit as today.
- Replay: a recorded pair is re-released together. Because the interleaving
  inside PostgreSQL is not controlled, overlap steps are marked
  `determinism: 'server-interleaved'`; exact replay checks the released commands
  and requires the same invariant failure, but not the same completion order or
  row counts inside the pair. Reports say so explicitly.
- Minimization may split a pair into a sequential order; the result is kept only
  if the same invariant failure reproduces.

## Qualification

- Knex 0.95.12 case: overlap exploration finds the duplicate lock row without a
  blocker session; repeated replays reproduce it in most attempts (measure and
  report the rate honestly).
- Existing single-release artifacts and tests unchanged; overlap off by default.
- A known-safe atomic statement (UPDATE ... SET v = v + 1) never violates under
  overlap.

## Schema

Coordinate with schema 4 (multi-connection lanes): add `limits.overlap` and
per-step `overlap` group numbers in the same version.
