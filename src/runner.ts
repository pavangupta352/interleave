import { createHash } from 'node:crypto';
import { AssertionError } from 'node:assert';
import { createOwnedDatabase, OwnedDatabaseCreationError } from './database.js';
import { assertCompletedRun } from './completed-run.js';
import { createProxy } from './proxy.js';
import { defineScenario } from './scenario.js';
import { ARTIFACT_LIMITS, parseRunArtifact, validateJsonValue } from './artifact.js';
import { assertEvidenceEnvelope, finalizeRunEvidence } from './evidence.js';
import { captureFixtureIdentity, FixtureIdentityError } from './fixture-identity.js';
import type { SourceIdentity } from './source-identity.js';
import { environmentMatches, transportMatches } from './environment.js';
import { postgresContextUrl, resolvePostgresTransport, runTransportIdentity } from './postgres-transport.js';
import { connectionFailureMessage, HARD_UPSTREAM_FAILURES, UpstreamConnectionError } from './protocol/upstream-transport.js';
import { resolveProtocolProfile } from './protocol-profile.js';
import { recordedFixtureProfile, resolveFixtureProfile } from './fixture-profile.js';
import { missingReplayIdentity } from './replay-readiness.js';
import {
  defaultConnectionLimit, fairLane, LaneBinder, laneLabel, parsePlanChoice, recordedConnectionProfile, resolveConnectionProfile,
  resolveOverlap, resolvePlanEntry, validatePlanEntries, type Lane, type LiveLane,
} from './lanes.js';
import type { ActorProxy, ActorResult, DatabaseContext, Outcome, OwnedDatabase, PendingUnit, RunOptions, RunResult, Scenario, TraceStep } from './types.js';

/** How long a multi-producer decision waits for a just-completed connection's next command. */
const LANE_SETTLE_MS = 25;

class Interrupted extends Error {
  constructor(readonly outcome: Outcome, message: string) { super(message); }
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 4096 ? `${text.slice(0, 4096)}… [message truncated]` : text;
}

function limit(value: number | undefined, fallback: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError(`${name} must be an integer from 1 to ${max}`);
  return result;
}

/** Run real application operations once in a new, owned PostgreSQL database. */
export async function runOnce(input: Scenario, options: RunOptions): Promise<RunResult> {
  if (options.source) throw new TypeError('Source selection requires runScenarioFile(); a scenario object cannot attest its loaded files');
  return execute(input, options);
}

/** Used by the supervised worker; its parent retains database ownership and teardown. */
export async function runInOwnedDatabase(input: Scenario, options: RunOptions, database: OwnedDatabase, source?: SourceIdentity): Promise<RunResult> {
  return execute(input, options, database, source);
}

async function execute(input: Scenario, options: RunOptions, providedDatabase?: OwnedDatabase, source?: SourceIdentity): Promise<RunResult> {
  const scenario = defineScenario(input);
  const maxSteps = limit(options.maxSteps, 100, 100_000, 'maxSteps');
  const timeoutMs = limit(options.timeoutMs, 10_000, 600_000, 'timeoutMs');
  const maxEvidenceBytes = limit(options.maxEvidenceBytes, 8 * 1024 * 1024, 12 * 1024 * 1024, 'maxEvidenceBytes');
  if (maxEvidenceBytes < 1024) throw new TypeError('maxEvidenceBytes must be at least 1024');
  if (!options.databaseUrl) throw new TypeError('databaseUrl must explicitly name a dedicated test PostgreSQL administrator connection');
  const names = Object.keys(scenario.actors).sort();
  // Lane and pair grammar is checked here; profile requirements once they are known.
  validatePlanEntries(options.plan, 'multi-producer-v1', names, 'pairs');
  if (Buffer.byteLength(JSON.stringify(options.plan ?? [])) > maxEvidenceBytes / 2) throw new TypeError('Initial schedule exceeds the evidence byte limit');
  const mode = options.mode ?? (options.replay ? 'replay' : 'explore');
  if (mode === 'replay' && !options.replay) throw new TypeError('replay mode requires a recorded run');
  if (options.replay) {
    const recorded = parseRunArtifact(options.replay);
    if (mode === 'replay') assertCompletedRun(recorded);
  }
  const recordedProtocol = options.replay?.limits.protocolProfile ?? 'sync-cycle-v1';
  const protocolProfile = resolveProtocolProfile(options.protocolProfile, mode === 'replay' ? recordedProtocol : undefined);
  const recordedConnections = options.replay ? recordedConnectionProfile(options.replay) : 'single-producer-v1';
  const connectionProfile = resolveConnectionProfile(options.connectionProfile, mode === 'replay' ? recordedConnections : undefined);
  const multi = connectionProfile === 'multi-producer-v1';
  const recordedOverlap = options.replay?.limits.overlap;
  const overlap = resolveOverlap(options.overlap, mode === 'replay' ? recordedOverlap : undefined);
  validatePlanEntries(options.plan, connectionProfile, names, overlap);
  if (options.maxConnectionsPerActor !== undefined && !Number.isSafeInteger(options.maxConnectionsPerActor)) {
    throw new TypeError('maxConnectionsPerActor must be an integer from 1 to 8');
  }
  const maxConnectionsPerActor = limit(options.maxConnectionsPerActor,
    mode === 'replay' ? options.replay!.limits.maxConnectionsPerActor ?? 1 : defaultConnectionLimit(connectionProfile), 8, 'maxConnectionsPerActor');
  const replayConnections = new Map((options.replay?.connections ?? []).map(item => [`${item.actor}\0${item.connection}`, item]));
  const expectedEnvironment = mode === 'replay' ? options.replay!.environment : mode === 'guided' ? undefined : options.expectedEnvironment;
  const fixtureProfile = resolveFixtureProfile(options.fixtureProfile, expectedEnvironment?.fixture);
  // One snapshot per execution: creation, setup, observation, capture, actors and cleanup.
  const transport = providedDatabase?.transport ?? resolvePostgresTransport(options.databaseUrl, options.upstreamTls);
  const started = performance.now();
  const controller = new AbortController();
  const result: RunResult = {
    schemaVersion: multi || overlap ? 4 : 3, scenario: scenario.name, outcome: 'harness-error', mode,
    plan: [...(options.plan ?? [])], trace: [], actors: [], connections: [],
    environment: { serverVersion: 'unknown', nodeVersion: process.version, ...(source ? { source } : {}), transport: runTransportIdentity(transport) },
    startedAt: new Date().toISOString(), durationMs: 0,
    limits: { maxSteps, timeoutMs, maxEvidenceBytes, maxConnectionsPerActor, protocolProfile,
      ...(multi || overlap ? { connectionProfile } : {}), ...(overlap ? { overlap } : {}) },
    cleanup: { complete: false },
  };
  let database: OwnedDatabase | undefined = providedDatabase;
  let failure: Interrupted | undefined;
  let creationCleanupError: string | undefined;
  let finished = false;
  let applicationRejected = false;
  const proxies: ActorProxy[] = [];
  const actors: Promise<void>[] = [];
  const settled = new Map<string, ActorResult>();
  // One lane per admitted connection generation. The single-producer proxy lets
  // only one lane of an actor hold commands at a time; multi-producer does not.
  interface LaneState extends Lane { queue: PendingUnit[]; running?: { step: TraceStep; blocked: boolean }; fingerprint?: string; closed: boolean; activityAt?: number }
  const lanes = new Map<string, LaneState>();
  const laneState = (actor: string, connection: number): LaneState => {
    const key = laneLabel(actor, connection);
    let lane = lanes.get(key);
    if (!lane) { lane = { actor, connection, queue: [], closed: false }; lanes.set(key, lane); }
    return lane;
  };
  const describeLane = (lane: Lane): string => multi ? laneLabel(lane.actor, lane.connection) : lane.actor;
  const binder = mode === 'replay' && multi ? new LaneBinder(options.replay!) : undefined;
  const pids = new Map<number, string>();
  const pidLanes = new Map<number, Lane>();
  const connectionPids = new Map<string, number>();
  const livePids = new Set<number>();
  const waiters = new Set<() => void>();
  let lastActor: string | undefined;
  const lastConnection = new Map<string, number>();
  let laneWait: string | undefined;
  let laneWaitSince = 0;
  let laneWaitEpoch = -1;
  // A plan entry that names an idle connection may wait for it, but not for ever
  // while every other actor is held: that is usually a deadlock of the plan.
  const laneWaitLimit = Math.min(5_000, Math.floor(timeoutMs / 2));
  let runtimeEpoch = 0;
  // Plan entries are decisions; an overlapped pair is one decision and two steps.
  let decisions = 0;
  let overlapped = false;
  let evidenceBytes = Buffer.byteLength(JSON.stringify(result)) + 256;
  assertEvidenceEnvelope(result, maxEvidenceBytes);

  const wake = (): void => { for (const callback of [...waiters]) callback(); };
  const stop = (outcome: Outcome, why: string): void => {
    failure ??= new Interrupted(outcome, why);
    wake();
  };
  const retain = (value: unknown): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 128;
    if (evidenceBytes + bytes > maxEvidenceBytes) {
      stop('inconclusive', `Execution reached its ${maxEvidenceBytes}-byte evidence limit`);
      return false;
    }
    evidenceBytes += bytes;
    return true;
  };
  const onAbort = (): void => stop('inconclusive', 'Execution was cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const deadline = setTimeout(() => stop('inconclusive', `Execution exceeded its ${timeoutMs} ms deadline${laneWait ? `; ${laneWait}` : ''}`), timeoutMs);

  const pause = async (milliseconds = 10): Promise<void> => new Promise(resolve => {
    const complete = (): void => { clearTimeout(timer); waiters.delete(complete); resolve(); };
    const timer = setTimeout(complete, milliseconds);
    waiters.add(complete);
  });
  const check = (): void => { if (failure) throw failure; };
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let complete = false;
    let value: T | undefined;
    let error: unknown;
    let rejected = false;
    operation.then(v => { value = v; complete = true; wake(); }, e => { error = e; rejected = true; complete = true; wake(); });
    while (!complete) { check(); await pause(); }
    check();
    if (rejected) throw error;
    return value as T;
  };

  try {
    check();
    if (mode === 'replay') {
      const missing = missingReplayIdentity(options.replay!);
      if (missing) throw new Interrupted('incompatible', missing);
    }
    if (mode === 'replay' && protocolProfile !== recordedProtocol) throw new Interrupted('incompatible', 'Replay protocol profile differs from the recorded run');
    if (mode === 'replay' && connectionProfile !== recordedConnections) throw new Interrupted('incompatible', 'Replay connection profile differs from the recorded run');
    if (mode === 'replay' && overlap !== recordedOverlap) throw new Interrupted('incompatible', 'Replay overlap mode differs from the recorded run');
    if (expectedEnvironment?.fixture && fixtureProfile !== recordedFixtureProfile(expectedEnvironment.fixture)) {
      throw new Interrupted('incompatible', 'Replay fixture profile differs from the recorded run');
    }
    if (expectedEnvironment?.transport && !transportMatches(expectedEnvironment.transport, result.environment.transport)) {
      throw new Interrupted('incompatible', 'Replay PostgreSQL transport differs from the recorded run; supply the same TLS policy, CA and hostname');
    }
    // Creation has its own bounded cleanup. Retain the result before applying the run deadline.
    database ??= await createOwnedDatabase(options.databaseUrl, transport);
    result.environment.serverVersion = database.serverVersion;
    check();
    if (mode === 'replay') {
      if (maxConnectionsPerActor !== (options.replay!.limits.maxConnectionsPerActor ?? 1)) throw new Interrupted('incompatible', 'Replay connection profile differs from the recorded run');
      if (options.replay!.scenario !== scenario.name) throw new Interrupted('incompatible', 'Replay scenario identity changed');
    }
    if (expectedEnvironment) {
      if (expectedEnvironment.serverVersion !== database.serverVersion) throw new Interrupted('incompatible', 'Replay PostgreSQL version differs from the recorded environment');
      if (expectedEnvironment.nodeVersion !== process.version) throw new Interrupted('incompatible', 'Replay Node.js version differs from the recorded environment');
      if (!expectedEnvironment.fixture) throw new Interrupted('incompatible', 'The recorded run has no fixture identity; use a guided run to create new bound evidence');
    }
    const owned = database;
    const context = (): DatabaseContext => ({
      db: owned.db, connectionString: postgresContextUrl(owned.transport),
      get connectionOptions() { return owned.connectionOptions; },
    });
    await bounded(scenario.setup(context()));
    try {
      const fixture = await captureFixtureIdentity(database.connectionString, {
        profile: fixtureProfile,
        timeoutMs: Math.max(1, Math.min(120_000, Math.floor(timeoutMs - (performance.now() - started)))),
        ...(options.signal ? { signal: options.signal } : {}),
        transport: database.transport,
      });
      check();
      if (!retain(fixture)) check();
      result.environment.fixture = fixture;
      if (expectedEnvironment) {
        const original = expectedEnvironment.fixture!;
        if (!environmentMatches(expectedEnvironment, result.environment)) {
          const changed = (['schema', 'data', 'sequences', 'settings'] as const).filter(component => original.components[component] !== fixture.components[component]);
          throw new Interrupted('incompatible', `Replay fixture identity changed${changed.length ? ` (${changed.join(', ')})` : ' (capture profile)'}`);
        }
      }
    } catch (error) {
      if (!(error instanceof FixtureIdentityError)) throw error;
      throw new Interrupted(['unsupported', 'budget-exceeded', 'aborted'].includes(error.code) ? 'inconclusive' : 'harness-error', error.message);
    }
    for (const actor of names) {
      const proxy = await createProxy({
        actor, upstreamUrl: database.transport.connectionString, upstreamTransport: database.transport, maxConnectionsPerActor, protocolProfile,
        connectionProfile,
        onUnit(unit) {
          if (finished) return;
          laneState(actor, unit.connection).queue.push(unit);
          wake();
        },
        onEvent(event) {
          if (finished) return;
          if (event.type === 'startup') {
            const identity = { actor: event.actor, connection: event.connection, fingerprint: event.fingerprint };
            if (retain(identity)) result.connections!.push(identity);
            Object.assign(laneState(actor, event.connection), { fingerprint: event.fingerprint, activityAt: performance.now() });
            if (binder) {
              const admitted = [...lanes.values()].flatMap(lane => lane.actor === actor && lane.fingerprint !== undefined ? [lane.fingerprint] : []);
              const changed = binder.startup(actor, event.connection, admitted, event.fingerprint);
              if (changed) stop('incompatible', changed);
            } else if (mode === 'replay') {
              const original = replayConnections.get(`${event.actor}\0${event.connection}`);
              if (!original || original.fingerprint !== event.fingerprint) stop('incompatible', `Replay actor startup identity changed for ${event.actor} connection ${event.connection}`);
            }
            wake();
            return;
          }
          const key = `${actor}\0${event.connection}`;
          if (event.type === 'connected') {
            pids.set(event.backendPid, actor); pidLanes.set(event.backendPid, { actor, connection: event.connection });
            livePids.add(event.backendPid); connectionPids.set(key, event.backendPid);
          } else {
            const pid = connectionPids.get(key);
            if (pid !== undefined) livePids.delete(pid);
            connectionPids.delete(key);
            laneState(actor, event.connection).closed = true;
          }
          runtimeEpoch++;
          wake();
        },
        // A trust or negotiation failure on an actor's upstream is a harness failure, not a timing artifact.
        onError(error) { if (!finished) stop(error instanceof UpstreamConnectionError && HARD_UPSTREAM_FAILURES.has(error.code) ? 'harness-error' : 'inconclusive', `${actor}: ${message(error)}`); },
      });
      proxies.push(proxy);
    }
    for (const [index, actor] of names.entries()) {
      const task = Promise.resolve().then(() => scenario.actors[actor]!({
        actor, connectionString: proxies[index]!.connectionString, signal: controller.signal,
      })).then(value => {
        const entry: ActorResult = { actor, status: 'fulfilled' };
        if (value !== undefined) {
          try { validateJsonValue(value); if (retain(value)) entry.value = JSON.parse(JSON.stringify(value)); }
          catch { stop('harness-error', `${actor} returned a value that cannot be recorded as JSON`); }
        }
        settled.set(actor, entry); wake();
      }, error => {
        // Only rejections observed before interruption are application failures.
        // Closing proxies or aborting actor work can itself reject pending work.
        if (!failure && !finished) applicationRejected = true;
        settled.set(actor, { actor, status: 'rejected', error: message(error) });
        wake();
      });
      actors.push(task);
    }

    const order = (a: Lane, b: Lane): number => names.indexOf(a.actor) - names.indexOf(b.actor) || a.connection - b.connection;
    const liveLanes = (): LiveLane[] => [...lanes.values()].sort(order).map(lane => ({
      actor: lane.actor, connection: lane.connection, running: lane.running !== undefined, closed: lane.closed,
      ...(lane.fingerprint === undefined ? {} : { fingerprint: lane.fingerprint }),
      ...(lane.queue[0] === undefined ? {} : { head: lane.queue[0] }),
    }));
    const active = (actor: string): boolean => [...lanes.values()].some(lane => lane.actor === actor && (lane.running !== undefined || lane.queue.length > 0));
    executionLoop: while (settled.size < names.length || [...lanes.values()].some(lane => lane.running !== undefined || lane.queue.length > 0)) {
      check();
      // Monitor actual backend wait state. Polling cadence never itself declares a lock.
      const sampledEpoch = runtimeEpoch;
      for (const lane of [...lanes.values()]) {
        const state = lane.running;
        if (!state) continue;
        const observation = await bounded(database.observeWait(state.step.backendPid));
        // A completed or disconnected blocker invalidates every earlier sample in this batch.
        if (sampledEpoch !== runtimeEpoch) continue executionLoop;
        if (lane.running !== state) continue;
        state.blocked = false;
        if (observation) {
          const ownBlockers = observation.blockerPids.every(pid => livePids.has(pid));
          if (!ownBlockers) throw new Interrupted('inconclusive', `${describeLane(lane)} is waiting for a lock outside the scheduled actors`);
          state.blocked = true;
          const previous = state.step.waits.at(-1);
          if ((!previous || JSON.stringify(previous) !== JSON.stringify(observation)) && retain(observation)) state.step.waits.push(observation);
        }
      }
      const current = liveLanes();
      // A queued command that no recorded connection can match is incompatible now,
      // rather than after waiting for a connection or actor that will never proceed.
      const mismatch = binder?.mismatch(current);
      if (mismatch) throw new Interrupted('incompatible', mismatch);
      if ([...lanes.values()].some(lane => lane.running && !lane.running.blocked)) { laneWait = undefined; await pause(); continue; }
      const allReady = names.every(actor => settled.has(actor) || active(actor));
      if (!allReady) { laneWait = undefined; await pause(); continue; }
      if (multi) {
        // A connection that has just started or completed usually queues its next
        // command within milliseconds. Let it, so choices do not depend on how quickly.
        const now = performance.now();
        const settling = [...lanes.values()].filter(lane => lane.activityAt !== undefined && now - lane.activityAt < LANE_SETTLE_MS
          && !lane.queue.length && !lane.running && !lane.closed && !settled.has(lane.actor));
        if (settling.length) { await pause(Math.max(1, Math.ceil(LANE_SETTLE_MS - (now - Math.min(...settling.map(lane => lane.activityAt!)))))); continue; }
      }
      const availableLanes = current.filter(lane => lane.head !== undefined && !lane.running);
      if (!availableLanes.length) { await pause(); continue; }
      if (result.trace.length >= maxSteps) throw new Interrupted('inconclusive', `Execution reached its ${maxSteps}-step limit`);
      const first = mode === 'replay' ? options.replay!.trace[result.trace.length] : undefined;
      if (mode === 'replay' && !first) throw new Interrupted('incompatible', 'Application emitted more queries than the replay contains');
      // A recorded pair is released together again; PostgreSQL still chooses how it interleaves.
      const expectedGroup = first === undefined ? undefined
        : first.overlap === first.index ? [first, options.replay!.trace[first.index + 1]!] : [first];
      const entry = mode === 'replay' ? undefined : options.plan?.[decisions];
      const choice = entry === undefined ? undefined : parsePlanChoice(entry)!;
      const chosen: Lane[] = [];
      let available: string[];
      if (!multi) {
        available = names.filter(actor => availableLanes.some(lane => lane.actor === actor));
        const requested = expectedGroup?.map(step => step.actor) ?? choice?.map(item => item.actor);
        for (const actor of requested ?? []) {
          if (!available.includes(actor)) throw new Interrupted('incompatible', `Schedule asks for ${actor}, which cannot issue its next query at step ${result.trace.length}`);
          chosen.push(availableLanes.find(lane => lane.actor === actor)!);
        }
        if (!requested) chosen.push(fairLane(names, availableLanes, lastActor, lastConnection));
      } else {
        available = availableLanes.map(lane => laneLabel(lane.actor, lane.connection));
        const members = expectedGroup ?? choice;
        if (!members) chosen.push(fairLane(names, availableLanes, lastActor, lastConnection));
        // Resolve members in order; a later member cannot take a lane chosen earlier.
        const view = current.map(lane => ({ ...lane }));
        // Replay stops preferring the recorded generation once waiting has made no progress.
        const patient = !(laneWait !== undefined && laneWaitEpoch === runtimeEpoch && performance.now() - laneWaitSince >= laneWaitLimit);
        for (const [index, member] of (members ?? []).entries()) {
          const resolution = expectedGroup
            ? binder!.resolve(expectedGroup[index]!, view, settled.has(member.actor), result.trace.length + index, patient)
            : resolvePlanEntry(member, view, settled.has(member.actor), lastConnection, result.trace.length + index);
          if (resolution.kind === 'incompatible') throw new Interrupted('incompatible', resolution.reason);
          // Waiting never becomes a pass. Replay waits until the run deadline; a plan
          // entry becomes infeasible once nothing else could proceed for laneWaitLimit.
          if (resolution.kind === 'wait') {
            if (laneWait !== resolution.reason || laneWaitEpoch !== runtimeEpoch) {
              laneWait = resolution.reason; laneWaitSince = performance.now(); laneWaitEpoch = runtimeEpoch;
            } else if (!expectedGroup && performance.now() - laneWaitSince >= laneWaitLimit) {
              throw new Interrupted('incompatible', `${resolution.reason}; nothing else could proceed for ${laneWaitLimit} ms`);
            }
            await pause(); continue executionLoop;
          }
          chosen.push(resolution.lane);
          view.find(lane => lane.actor === resolution.lane.actor && lane.connection === resolution.lane.connection)!.running = true;
        }
      }
      laneWait = undefined;
      if (result.trace.length + chosen.length > maxSteps) throw new Interrupted('inconclusive', `Execution reached its ${maxSteps}-step limit`);
      const releasedAt = performance.now() - started;
      const group: { lane: LaneState; unit: PendingUnit; step: TraceStep }[] = [];
      for (const [index, selected] of chosen.entries()) {
        const lane = lanes.get(laneLabel(selected.actor, selected.connection))!;
        const actor = lane.actor;
        const unit = lane.queue.shift()!;
        const position = result.trace.length + index;
        const expected = expectedGroup?.[index];
        if (Buffer.byteLength(unit.sql) > ARTIFACT_LIMITS.maxSqlBytes) throw new Interrupted('inconclusive', 'SQL exceeds the supported evidence byte limit');
        if (expected && !multi && (expected.actor !== unit.actor || expected.connection !== unit.connection || expected.ordinal !== unit.ordinal || expected.protocol !== unit.protocol || expected.sql !== unit.sql || expected.fingerprint !== unit.fingerprint)) {
          throw new Interrupted('incompatible', `Replay query or actor startup identity changed for ${actor} at step ${position}`);
        }
        const stage = unit.stage ?? 'complete';
        const cycle = unit.cycle ?? unit.ordinal;
        if (expected && ((expected.stage ?? 'complete') !== stage || (expected.cycle ?? expected.ordinal) !== cycle || expected.prefixOrdinal !== unit.prefixOrdinal)) {
          throw new Interrupted('incompatible', `Replay protocol stage changed for ${actor} at step ${position}`);
        }
        // The binder released only a head identical to the recorded step; the
        // binding is final for the rest of this execution.
        if (expected && binder) binder.bind(actor, expected.connection, unit.connection);
        const step: TraceStep = {
          index: position, actor, connection: unit.connection, ordinal: unit.ordinal,
          protocol: unit.protocol, sql: unit.sql, fingerprint: unit.fingerprint, backendPid: unit.backendPid,
          available, releasedAt, waits: [],
          ...(protocolProfile === 'describe-flush-v1' ? { stage, cycle,
            ...(unit.prefixOrdinal === undefined ? {} : { prefixOrdinal: unit.prefixOrdinal }) } : {}),
          ...(chosen.length > 1 ? { overlap: result.trace.length } : {}),
        };
        group.push({ lane, unit, step });
      }
      // Retain the whole group before releasing any of it, so evidence never holds half a pair.
      if (!group.every(item => retain(item.step))) check();
      decisions++;
      if (group.length > 1) overlapped = true;
      for (const { lane, step } of group) {
        result.trace.push(step);
        lastActor = lane.actor;
        lastConnection.set(lane.actor, lane.connection);
        lane.running = { step, blocked: false };
      }
      runtimeEpoch++;
      // Release in one synchronous pass: a pair's commands are written upstream together.
      for (const { lane, unit, step } of group) {
        unit.release().then(completion => {
          lane.activityAt = performance.now();
          if (retain(completion)) {
            step.completedAt = performance.now() - started;
            step.completion = protocolProfile === 'describe-flush-v1' && completion.kind !== 'metadata'
              ? { ...completion, kind: 'ready' } : completion;
          }
          delete lane.running;
          runtimeEpoch++;
          wake();
        }, error => {
          delete lane.running;
          runtimeEpoch++;
          if (!finished) stop('inconclusive', `${describeLane(lane)} query did not complete: ${message(error)}`);
          wake();
        });
      }
    }
    check();
    if (binder) {
      const admitted = [...lanes.values()].flatMap(lane => lane.fingerprint === undefined ? [] : [{ actor: lane.actor, fingerprint: lane.fingerprint }]);
      if (!binder.complete(admitted)) throw new Interrupted('incompatible', 'Application finished before consuming every recorded actor connection');
    } else if (mode === 'replay' && result.connections!.length !== options.replay!.connections!.length) {
      throw new Interrupted('incompatible', 'Application finished before consuming every recorded actor connection');
    }
    if (mode === 'replay' && result.trace.length !== options.replay!.trace.length) throw new Interrupted('incompatible', 'Application finished before consuming every replay step');
    if (mode !== 'replay' && (options.plan?.length ?? 0) > decisions) throw new Interrupted('incompatible', 'Application finished before consuming every requested schedule choice');
    if (mode === 'replay') {
      // Single-producer blockers are actors. Multi-producer blockers are recorded
      // lanes; live lanes are translated through the replay's bijection.
      const original = new Map(options.replay!.trace.map(step => [step.backendPid, multi ? laneLabel(step.actor, step.connection) : step.actor]));
      const recordedIdentity = (pid: number): string => original.get(pid) ?? 'unknown';
      const liveIdentity = (pid: number): string => {
        if (!binder) return pids.get(pid) ?? 'unknown';
        const lane = pidLanes.get(pid);
        const connection = lane === undefined ? undefined : binder.recordedFor(lane.actor, lane.connection);
        return lane === undefined || connection === undefined ? 'unknown' : laneLabel(lane.actor, connection);
      };
      const describeWaits = (item: TraceStep, identity: (pid: number) => string): string => {
        const observations = item.waits.map(wait => JSON.stringify({
          type: wait.waitEventType, event: wait.waitEvent,
          blockers: [...new Set(wait.blockerPids.map(identity))].sort(),
        }));
        return JSON.stringify([...new Set(observations)].sort());
      };
      for (const step of result.trace) {
        const recorded = options.replay!.trace[step.index]!;
        // PostgreSQL chose how an overlapped pair interleaved; its waits and states may differ.
        if (recorded.overlap !== undefined) continue;
        if (describeWaits(recorded, recordedIdentity) !== describeWaits(step, liveIdentity)) {
          throw new Interrupted('incompatible', `Replay lock-wait evidence changed for ${step.actor} at step ${step.index}`);
        }
        if (recorded.completion?.transactionStatus !== step.completion?.transactionStatus) {
          throw new Interrupted('incompatible', `Replay transaction state changed for ${step.actor} at step ${step.index}`);
        }
      }
    }
    result.actors = names.map(actor => settled.get(actor)!);
    if (result.actors.some(actor => actor.status === 'rejected')) {
      result.outcome = 'actor-error';
      result.reason = 'One or more application operations rejected; the invariant was not evaluated';
    } else {
      try {
        await bounded(scenario.invariant(Object.assign(context(), { results: result.actors })));
        result.outcome = 'passed';
      } catch (error) {
        if (error instanceof Interrupted) throw error;
        if (!(error instanceof AssertionError)) throw new Interrupted('harness-error', `Invariant evaluation failed without an assertion: ${message(error)}`);
        result.outcome = 'violation';
        const text = message(error);
        result.failure = { name: error.name, message: text, fingerprint: createHash('sha256').update(`${scenario.name}\0${error.name}\0${error.message}`).digest('hex') };
      }
    }
  } catch (error) {
    if (error instanceof OwnedDatabaseCreationError) creationCleanupError = error.message;
    // An interrupted execution cannot claim complete actor-error evidence, but
    // must retain a failure already observed before the harness stopped it.
    result.outcome = error instanceof Interrupted && !applicationRejected ? error.outcome : 'harness-error';
    let reason = error instanceof Interrupted ? message(error) : connectionFailureMessage(error) ?? message(error);
    if (mode === 'replay' && overlapped && error instanceof Interrupted && error.outcome === 'incompatible') {
      reason = message(`${reason}; this run released overlapped pairs, and PostgreSQL may interleave them differently on each replay`);
    }
    result.reason = applicationRejected
      ? message(`One or more application operations rejected before execution was interrupted; ${reason}`)
      : reason;
  } finally {
    finished = true;
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    const cleanupErrors: string[] = creationCleanupError ? [creationCleanupError] : [];
    const closed = await Promise.allSettled(proxies.map(proxy => proxy.close()));
    for (const item of closed) if (item.status === 'rejected') cleanupErrors.push(message(item.reason));
    if (database) {
      try { await database.close(); } catch (error) { cleanupErrors.push(message(error)); }
    }
    // Application promises may involve external services. Never wait on them without a limit.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(actors), new Promise<void>(resolve => { settleTimer = setTimeout(resolve, 100); })]);
    if (settleTimer) clearTimeout(settleTimer);
    result.actors = names.flatMap(actor => { const entry = settled.get(actor); return entry ? [entry] : []; });
    result.cleanup = cleanupErrors.length ? { complete: false, error: cleanupErrors.join('; ') } : { complete: true };
    if (cleanupErrors.length) {
      result.outcome = 'harness-error';
      result.reason = `Database/proxy cleanup failed: ${cleanupErrors.join('; ')}`;
      delete result.failure;
    }
    result.durationMs = performance.now() - started;
  }
  return finalizeRunEvidence(result, maxEvidenceBytes);
}
