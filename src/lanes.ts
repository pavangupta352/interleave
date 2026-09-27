import type { ConnectionProfile, OverlapMode, ProtocolKind, RunResult, StepIdentity, StepStage, TraceStep } from './types.js';

/** A lane is one admitted connection generation of an actor, written `actor#n`. */
export interface Lane { actor: string; connection: number }

/** Identity of a queued or recorded unit; ordinals, cycles and prefixes are lane-local. */
export interface UnitIdentity {
  ordinal: number;
  protocol: ProtocolKind;
  sql: string;
  fingerprint: string;
  stage?: StepStage;
  cycle?: number;
  prefixOrdinal?: number;
}

/** Scheduler view of one live lane at a decision point. */
export interface LiveLane extends Lane {
  /** Startup fingerprint once the actor's startup packet was accepted. */
  fingerprint?: string;
  /** Oldest queued, unreleased unit. */
  head?: UnitIdentity;
  /** A released unit has neither completed nor failed yet. */
  running: boolean;
  /** Both sockets of this connection have closed. */
  closed: boolean;
}

export type PlanResolution =
  | { kind: 'release'; lane: Lane }
  | { kind: 'wait'; reason: string }
  | { kind: 'incompatible'; reason: string };

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PLAN_ENTRY = /^([a-zA-Z][a-zA-Z0-9_-]{0,47})(?:#(0|[1-9][0-9]{0,8}))?$/;
/** Longest plan choice: two lane labels joined by `+`. */
export const MAX_PLAN_CHOICE_LENGTH = 117;

type PlanEntry = { actor: string; connection?: number };

/** Resolve only an omitted option; null and unknown strings are invalid input. */
export function resolveConnectionProfile(value: unknown, fallback: ConnectionProfile = 'single-producer-v1'): ConnectionProfile {
  const selected = value === undefined ? fallback : value;
  if (selected !== 'single-producer-v1' && selected !== 'multi-producer-v1') {
    throw new TypeError('connectionProfile must be single-producer-v1 or multi-producer-v1');
  }
  return selected;
}

/** Resolve only an omitted option; overlap is off unless selected. */
export function resolveOverlap(value: unknown, fallback?: OverlapMode): OverlapMode | undefined {
  const selected = value === undefined ? fallback : value;
  if (selected !== undefined && selected !== 'pairs') throw new TypeError('overlap must be pairs');
  return selected;
}

/** Records before version 4 are single-producer. */
export function recordedConnectionProfile(run: Pick<RunResult, 'limits'>): ConnectionProfile {
  return run.limits.connectionProfile ?? 'single-producer-v1';
}

/** Admitted connection cap when the caller omits maxConnectionsPerActor. */
export function defaultConnectionLimit(profile: ConnectionProfile): number {
  return profile === 'multi-producer-v1' ? 8 : 1;
}

export function laneLabel(actor: string, connection: number): string {
  return `${actor}#${connection}`;
}

/** Parse `actor` or `actor#n`; malformed and prototype-sensitive names return undefined. */
export function parsePlanEntry(value: unknown): PlanEntry | undefined {
  if (typeof value !== 'string') return undefined;
  const match = PLAN_ENTRY.exec(value);
  if (!match || PROTOTYPE_KEYS.has(match[1]!)) return undefined;
  return match[2] === undefined ? { actor: match[1]! } : { actor: match[1]!, connection: Number(match[2]) };
}

/** Parse one choice: an entry, or with overlap two entries joined by `+`. */
export function parsePlanChoice(value: unknown): PlanEntry[] | undefined {
  if (typeof value !== 'string' || value.length > MAX_PLAN_CHOICE_LENGTH) return undefined;
  const parts = value.split('+');
  if (parts.length > 2) return undefined;
  const entries: PlanEntry[] = [];
  for (const part of parts) {
    const entry = parsePlanEntry(part);
    if (!entry) return undefined;
    entries.push(entry);
  }
  return entries;
}

/** Parse an `actor#n` lane label; a bare actor id is not a lane. */
export function parseLaneLabel(value: unknown): Lane | undefined {
  const entry = parsePlanEntry(value);
  return entry?.connection === undefined ? undefined : { actor: entry.actor, connection: entry.connection };
}

/** Shared API/CLI/worker validation before any database work. */
export function validatePlanEntries(plan: unknown, profile: ConnectionProfile, actors?: readonly string[], overlap?: OverlapMode): void {
  if (plan === undefined) return;
  if (!Array.isArray(plan) || plan.length > 100_000) throw new TypeError('Invalid initial schedule');
  for (const value of plan) {
    const choice = parsePlanChoice(value);
    if (!choice) throw new TypeError('plan contains an invalid actor');
    for (const entry of choice) {
      if (entry.connection !== undefined && profile !== 'multi-producer-v1') {
        throw new TypeError('Connection-qualified plan entries such as alice#1 require connectionProfile multi-producer-v1');
      }
      if (actors && !actors.includes(entry.actor)) throw new TypeError('plan contains an unknown actor');
    }
    if (choice.length === 2) {
      if (overlap !== 'pairs') throw new TypeError('Pair plan entries such as alice+bob require overlap pairs');
      const [first, second] = choice as [PlanEntry, PlanEntry];
      // One single-producer actor has one command connection; a lane cannot pair with itself.
      if (first.actor === second.actor && (profile !== 'multi-producer-v1' || (first.connection !== undefined && first.connection === second.connection))) {
        throw new TypeError(`A pair plan entry must name two different ${profile === 'multi-producer-v1' ? 'lanes' : 'actors'}`);
      }
    }
  }
}

/** Actors that released commands on more than one connection. */
export function multiLaneActors(trace: readonly StepIdentity[]): Set<string> {
  const seen = new Map<string, number>();
  const multi = new Set<string>();
  for (const step of trace) {
    const first = seen.get(step.actor);
    if (first === undefined) seen.set(step.actor, step.connection);
    else if (first !== step.connection) multi.add(step.actor);
  }
  return multi;
}

/** One recorded scheduler decision: a single release, or an overlapped pair of steps. */
export interface Decision {
  /** Index of the decision's first trace step. */
  step: number;
  /** The choice in plan notation. */
  choice: string;
  /** Entries that could proceed, as recorded. */
  available: string[];
}

/**
 * Decisions equivalent to a recorded trace. Only actors that released commands on
 * more than one connection are lane-qualified; everything else keeps actor ids.
 */
export function decisionsFromTrace(run: Pick<RunResult, 'limits' | 'trace'>): Decision[] {
  const multi = recordedConnectionProfile(run) === 'multi-producer-v1' ? multiLaneActors(run.trace) : new Set<string>();
  const name = (step: TraceStep): string => multi.has(step.actor) ? laneLabel(step.actor, step.connection) : step.actor;
  const decisions: Decision[] = [];
  for (let index = 0; index < run.trace.length; index++) {
    const step = run.trace[index]!;
    const pair = step.overlap === index ? run.trace[index + 1] : undefined;
    decisions.push({ step: index, choice: pair ? `${name(step)}+${name(pair)}` : name(step), available: step.available });
    if (pair) index++;
  }
  return decisions;
}

/** Choices equivalent to a recorded trace; see decisionsFromTrace(). */
export function planFromTrace(run: Pick<RunResult, 'limits' | 'trace'>): string[] {
  return decisionsFromTrace(run).map(decision => decision.choice);
}

/** Convert a recorded available entry to the plan notation used for that trace. */
export function planChoice(available: string, multi: ReadonlySet<string>): string {
  const lane = parseLaneLabel(available);
  if (!lane) return available;
  return multi.has(lane.actor) ? available : lane.actor;
}

/**
 * Choices at one recorded decision in plan notation: each available entry, and
 * with overlap each unordered pair of them.
 */
export function decisionChoices(available: readonly string[], multi: ReadonlySet<string>, overlap: OverlapMode | undefined): string[] {
  const singles = available.map(entry => planChoice(entry, multi));
  const choices = new Set(singles);
  if (overlap === 'pairs') {
    for (let first = 0; first < singles.length; first++) {
      for (let second = first + 1; second < singles.length; second++) choices.add(`${singles[first]}+${singles[second]}`);
    }
  }
  return [...choices];
}

/**
 * Lane-aware fair fallback. Rotate among actors after the previous choice, then
 * among the chosen actor's available lanes after its previously released lane.
 */
export function fairLane(names: readonly string[], available: readonly Lane[], lastActor: string | undefined,
  lastConnection: ReadonlyMap<string, number>): Lane {
  if (!available.length) throw new TypeError('Fair selection requires an available lane');
  const start = lastActor === undefined ? 0 : (names.indexOf(lastActor) + 1) % names.length;
  const actor = [...names.slice(start), ...names.slice(0, start)].find(name => available.some(lane => lane.actor === name));
  if (actor === undefined) throw new TypeError('Available lane names an unknown actor');
  const lanes = available.filter(lane => lane.actor === actor).sort((a, b) => a.connection - b.connection);
  const previous = lastConnection.get(actor);
  return (previous === undefined ? undefined : lanes.find(lane => lane.connection > previous)) ?? lanes[0]!;
}

/**
 * Resolve one explicit plan entry at a decision point (every running unit is
 * complete or lock-blocked and every actor is ready). An actor entry chooses among
 * that actor's available lanes. A lane entry waits, bounded by the run deadline,
 * while its connection may still queue a command; it never becomes a pass.
 */
export function resolvePlanEntry(entry: PlanEntry, lanes: readonly LiveLane[], settled: boolean,
  lastConnection: ReadonlyMap<string, number>, step: number): PlanResolution {
  const label = entry.connection === undefined ? entry.actor : laneLabel(entry.actor, entry.connection);
  const blocked: PlanResolution = { kind: 'incompatible', reason: `Schedule asks for ${label}, which cannot issue its next query at step ${step}` };
  const own = lanes.filter(lane => lane.actor === entry.actor);
  if (entry.connection === undefined) {
    const available = own.filter(lane => lane.head && !lane.running);
    return available.length ? { kind: 'release', lane: fairLane([entry.actor], available, undefined, lastConnection) } : blocked;
  }
  const lane = own.find(candidate => candidate.connection === entry.connection);
  if (lane?.head && !lane.running) return { kind: 'release', lane };
  if (settled || lane?.running || lane?.closed) return blocked;
  return { kind: 'wait', reason: `Schedule asks for ${label} at step ${step}, which has not queued its next command` };
}

function sameUnit(expected: StepIdentity, unit: UnitIdentity): boolean {
  return expected.ordinal === unit.ordinal && expected.protocol === unit.protocol && expected.sql === unit.sql
    && expected.fingerprint === unit.fingerprint && (expected.stage ?? 'complete') === (unit.stage ?? 'complete')
    && (expected.cycle ?? expected.ordinal) === (unit.cycle ?? unit.ordinal) && expected.prefixOrdinal === unit.prefixOrdinal;
}

interface RecordedLane extends Lane { fingerprint: string; steps: StepIdentity[]; live?: number }

/**
 * Exact multi-producer replay binds recorded lanes to live lanes lazily. A binding
 * is made when the recorded lane's first command is released and never changes,
 * so the result is one bijection over the whole execution. The live connection
 * with the recorded generation is preferred; another unbound connection is used
 * when accept order differs and its queued head, startup and stage match.
 */
export class LaneBinder {
  private readonly recorded = new Map<string, RecordedLane>();
  private readonly live = new Map<string, number>();

  constructor(run: Pick<RunResult, 'connections' | 'trace'>) {
    for (const connection of run.connections ?? []) {
      this.recorded.set(laneLabel(connection.actor, connection.connection), { ...connection, steps: [] });
    }
    for (const step of run.trace) this.recorded.get(laneLabel(step.actor, step.connection))?.steps.push(step);
  }

  /** Recorded generation bound to a live connection, if any. */
  recordedFor(actor: string, liveConnection: number): number | undefined {
    return this.live.get(laneLabel(actor, liveConnection));
  }

  /** Live generation bound to a recorded connection, if any. */
  liveFor(actor: string, recordedConnection: number): number | undefined {
    return this.recorded.get(laneLabel(actor, recordedConnection))?.live;
  }

  bind(actor: string, recordedConnection: number, liveConnection: number): void {
    const recorded = this.recorded.get(laneLabel(actor, recordedConnection));
    const liveKey = laneLabel(actor, liveConnection);
    if (!recorded) throw new TypeError('Cannot bind an unrecorded connection');
    if (recorded.live === liveConnection && this.live.get(liveKey) === recordedConnection) return;
    if (recorded.live !== undefined || this.live.has(liveKey)) throw new TypeError('Replay lane bindings are one-to-one');
    recorded.live = liveConnection;
    this.live.set(liveKey, recordedConnection);
  }

  /** A newly accepted startup may not exceed the recorded connections with that identity. */
  startup(actor: string, connection: number, liveFingerprints: readonly string[], fingerprint: string): string | undefined {
    const recorded = [...this.recorded.values()].filter(lane => lane.actor === actor && lane.fingerprint === fingerprint).length;
    const live = liveFingerprints.filter(value => value === fingerprint).length;
    return live > recorded ? `Replay actor startup identity changed for ${actor} connection ${connection}` : undefined;
  }

  /** Detect a queued command that can never correspond to the recording. */
  mismatch(lanes: readonly LiveLane[]): string | undefined {
    for (const lane of lanes) {
      if (!lane.head) continue;
      const recordedConnection = this.recordedFor(lane.actor, lane.connection);
      if (recordedConnection !== undefined) {
        const expected = this.recorded.get(laneLabel(lane.actor, recordedConnection))!.steps[lane.head.ordinal];
        if (!expected) return `Application emitted more queries than the replay contains for ${lane.actor} connection ${lane.connection}`;
        if (!sameUnit(expected, lane.head)) return `Replay query or actor startup identity changed for ${lane.actor} connection ${lane.connection}`;
        continue;
      }
      const possible = lane.head.ordinal === 0 && [...this.recorded.values()].some(recorded => recorded.actor === lane.actor
        && recorded.live === undefined && recorded.fingerprint === lane.fingerprint && recorded.steps[0] !== undefined
        && sameUnit(recorded.steps[0], lane.head!));
      if (!possible) return `Replay query or actor startup identity changed for ${lane.actor} connection ${lane.connection}`;
    }
    return undefined;
  }

  /** Choose the live lane for the next recorded step, or wait while it may still appear. */
  resolve(expected: StepIdentity, lanes: readonly LiveLane[], settled: boolean, step: number): PlanResolution {
    const recorded = this.recorded.get(laneLabel(expected.actor, expected.connection));
    const label = laneLabel(expected.actor, expected.connection);
    const blocked: PlanResolution = { kind: 'incompatible', reason: `Replay expects ${label}, which cannot issue its next query at step ${step}` };
    if (!recorded) return { kind: 'incompatible', reason: `Replay step ${step} references an unrecorded actor connection` };
    const own = lanes.filter(lane => lane.actor === expected.actor);
    if (recorded.live !== undefined) {
      const lane = own.find(candidate => candidate.connection === recorded.live);
      if (lane?.head && !lane.running) {
        return sameUnit(expected, lane.head) ? { kind: 'release', lane }
          : { kind: 'incompatible', reason: `Replay query or actor startup identity changed for ${expected.actor} at step ${step}` };
      }
      if (settled || !lane || lane.running || lane.closed) return blocked;
      return { kind: 'wait', reason: `Replay step ${step} waits for ${label}, which has not queued its next command` };
    }
    const unbound = (lane: LiveLane): boolean => !this.live.has(laneLabel(lane.actor, lane.connection))
      && !lane.closed && lane.fingerprint === recorded.fingerprint;
    const matches = (lane: LiveLane): boolean => unbound(lane) && lane.head !== undefined && !lane.running && sameUnit(expected, lane.head);
    const same = own.find(lane => lane.connection === expected.connection);
    if (same && matches(same)) return { kind: 'release', lane: same };
    const waiting: PlanResolution = { kind: 'wait', reason: `Replay step ${step} waits for the first command of ${label}` };
    // Unbound recorded connections that begin with this exact command. When they
    // later diverge, queued heads cannot tell them apart: keep the recorded
    // generation while it may still queue, as accept order normally matches.
    const peers = [...this.recorded.values()].filter(lane => lane.actor === expected.actor && lane.live === undefined
      && lane.fingerprint === recorded.fingerprint && lane.steps[0] !== undefined && sameUnit(expected, lane.steps[0]));
    const ambiguous = peers.some(peer => peer.steps.length !== recorded.steps.length
      || peer.steps.some((item, index) => !sameUnit(item, recorded.steps[index]!)));
    if (ambiguous && !settled) {
      const identities = [...this.recorded.values()].filter(lane => lane.actor === expected.actor && lane.fingerprint === recorded.fingerprint).length;
      const admitted = own.filter(lane => lane.fingerprint === recorded.fingerprint).length;
      if (same === undefined ? admitted < identities : unbound(same) && same.head === undefined && !same.running) return waiting;
    }
    const candidate = own.filter(matches).sort((a, b) => a.connection - b.connection)[0];
    if (candidate) return { kind: 'release', lane: candidate };
    return settled ? blocked : waiting;
  }

  /** Every recorded startup identity must have been admitted the same number of times. */
  complete(live: readonly { actor: string; fingerprint: string }[]): boolean {
    const count = (items: Iterable<{ actor: string; fingerprint: string }>): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const item of items) counts.set(`${item.actor}\0${item.fingerprint}`, (counts.get(`${item.actor}\0${item.fingerprint}`) ?? 0) + 1);
      return counts;
    };
    const expected = count(this.recorded.values());
    const actual = count(live);
    return expected.size === actual.size && [...expected].every(([key, value]) => actual.get(key) === value);
  }
}
