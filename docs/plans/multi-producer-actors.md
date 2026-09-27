# Multi-connection actors design

Status: implemented on `feature/multi-session`, 27 September 2026. Support is
limited to the qualification recorded below; other drivers, pools and servers
need their own evidence.

## Problem

Real operations often use several PostgreSQL connections at once: a `pg.Pool`
serving `Promise.all` queries, an ORM running a lookup outside its open
transaction, or a job runner with separate lock and work connections. Before
this profile an actor could admit up to eight connections, but only one could
send commands; a second producer was an explicit unsupported-profile error. That
excluded a large share of ordinary application code.

## Contract

- New connection profile `multi-producer-v1`, selected explicitly with
  `connectionProfile: 'multi-producer-v1'` (API) and `--connection-profile`
  (CLI). The default remains the existing `single-producer-v1` behavior; every
  existing artifact and test keeps its meaning.
- A **lane** is one admitted connection of an actor, written `actor#n` where `n`
  is the zero-based connection generation in accept order. Each lane is
  sequential at the protocol level: at most one released unit per lane is in
  flight, released in that lane's order.
- The global release rule is unchanged: another unit is released only when every
  running unit, on any lane, has completed or is confirmed blocked by a real lock
  observation. PostgreSQL's deadlock detection remains authoritative. Lanes of
  one actor can therefore block each other, and the wait records the blocking
  lane.
- An actor is ready for a scheduling decision when it has settled or at least one
  of its lanes has a queued or running unit. Lanes that are idle are not waited
  for (a pool may keep idle connections indefinitely).
- The proxy accepts multiple command-producing sessions per actor only in the
  multi-producer profile, still bounded by `maxConnectionsPerActor` (≤ 8). That
  cap defaults to 8 in this profile, since a profile that admits one connection
  would reject the pool it exists for; it stays 1 by default otherwise.
- Fair fallback rotates among actors after the previous choice, then among the
  chosen actor's available lanes after its previously released lane.

## Identity and replay

Connection generations follow TCP accept order, which is racy when a pool opens
two sockets concurrently, and applications bind their own logical work to
sockets. Lane numbers alone are therefore not stable across runs.

- Recording keeps live generations in `trace[].connection`, `connections[]` and
  the lane labels of `trace[].available`.
- **Exact replay binds lanes lazily and permanently.** Per actor, a bijection
  maps recorded lanes to live lanes. When the next expected step names an unbound
  recorded lane, it is bound to an unbound live lane of the same actor whose
  queued head unit matches the expected step's protocol, SQL, fingerprint, stage,
  cycle and prefix, and whose startup fingerprint matches the recorded
  connection's. The live lane with the recorded generation is preferred; that is
  exact whenever accept order did not change. Otherwise the lowest matching live
  lane is chosen. A binding never changes afterwards, so the whole execution is
  checked against one bijection. Startup counts, wait blockers and transaction
  states are compared through it.
- If no candidate is queued yet and the actor has not settled, replay waits
  (bounded by the run deadline) instead of failing. Any mismatch remains
  `incompatible`, and so does a queued command that can never correspond to the
  recording: a bound lane whose head differs from its recorded next step, or an
  unbound lane whose head matches no unbound recorded lane's first step. This
  keeps a changed query from turning into a deadline wait.
- Correction to the original plan. It said identical candidates are
  interchangeable, so the lowest live lane could be chosen. That holds only for
  the one unit being released. Two connections that both start with `BEGIN` and
  then diverge have identical heads but different futures; choosing the lowest
  lane binds the wrong logical task even when accept order did not change, for
  example when the recording released the second connection's `BEGIN` first.
  The implementation therefore prefers the recorded generation, and when
  unbound recorded lanes share the first command but later diverge, it waits for
  the recorded generation while that connection may still queue. Mid-run swaps
  are rejected on principle: they would break the single bijection. The residual
  case is identical prefixes combined with a changed accept order. Replay then
  reports `incompatible`, never a false match; an automatic retry with another
  binding is not implemented.
- Exploration and minimization plans may contain `actor#n` entries. A lane
  number refers to the accept order of the run executing the plan. A plan entry
  whose lane is not currently available waits (bounded by the run deadline)
  while its actor has not settled and the lane has neither closed nor is
  lock-blocked; otherwise the prefix is infeasible (`incompatible`), never a
  pass. A deadline reached while waiting is `inconclusive` and names the lane.
  A plain `actor` entry chooses among that actor's available lanes and, like the
  single-producer profile, never waits for an idle lane. Plans derived from a
  trace use lane-qualified entries only for actors that produced commands on
  more than one lane.
- Artifacts using the profile are schema version 4: `limits.connectionProfile`
  (`multi-producer-v1`) and `limits.maxConnectionsPerActor` are required, plan
  entries may be lane-qualified, `trace[].available` lists lane labels of
  recorded connections (at most 64), a lock blocker must belong to a different
  lane rather than a different actor, and staged `describe-flush-v1` cycles may
  be open on several lanes of one actor. Lane references in `available`, and in
  the plan of a completed run, must name recorded connections. Schema 3 remains
  the format for single-producer runs; 1-3 stay readable and unchanged.

## Qualification

1. Unit: plan and lane grammar, profile resolution, CLI validation, lane-aware
   fair fallback, plan-entry resolution, the replay binder (recorded generation,
   reversed accept order, ambiguous prefixes, queryless connections, mismatch
   detection, startup counts, staged identity), and the schema 4 parser (valid
   bytes, required fields, unknown fields, lane references to unrecorded
   connections, intra-actor blockers, concurrent staged lanes, legacy grammar).
2. Real PostgreSQL:
   - Proxy: two sessions of one actor both produce commands, one lane completes
     while the other lane's command is still held, and invalid profiles are
     rejected before listening.
   - `pg.Pool({ max: 2 })` actor issuing two concurrent read-modify-writes plus
     another actor: record a real lost update, replay it exactly twice, reduce it,
     and find it by exploration from a passing lane-qualified plan.
   - Replay with deliberately reversed socket accept order (the first pool
     client's TCP connect is delayed) matches exactly and records the swapped
     generations; a changed query under reversed order is `incompatible` well
     before the deadline.
   - Two lanes of one actor blocking each other through a row lock: the wait is
     observed and attributed to the other lane, replay compares it through the
     bijection, and removing it from the record is `incompatible`. A lane
     waiting on an unscheduled direct session is `inconclusive`.
   - Kysely 0.29.5 transaction plus a side query through its pool: a real double
     redemption with a real lock wait, replayed exactly; a serial actor-level
     plan passes.
   - Postgres.js 3.4.9 with `max: 2` under `describe-flush-v1`: staged cycles
     open on two lanes of one actor, a real lost update, replayed exactly twice.
   - Single-producer artifacts and tests unchanged; the unsupported error remains
     in the default profile, and lane plans are rejected there.
3. CLI (supervised file run with lanes, exact replay, profile mismatch,
   reduction, guided replay), a portable export of a lane record that installs
   offline and replays exactly, report lane labels (Impeccable workflow,
   DESIGN.md, browser checks in Chromium, Firefox and WebKit at desktop and
   mobile sizes), docs (API, concepts, CLI, compatibility, troubleshooting,
   reports).

Environments: PostgreSQL 16.15, 17.11 and 18.6 (official images) on Node.js
24.7.0, and PostgreSQL 16.15 on Node.js 22.18.0; the complete existing
integration, TLS and managed suites still pass with the profile code in place.

Not yet qualified: other drivers and ORMs with multi-connection pools, pools
larger than the per-actor cap, cancellation routing, and an installed-package
export of a schema 4 record. The CI matrix runs these tests as part of the
existing integration and browser jobs; no separate job was added.
