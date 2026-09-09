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
import { environmentMatches } from './environment.js';
import { resolveProtocolProfile } from './protocol-profile.js';
import { recordedFixtureProfile, resolveFixtureProfile } from './fixture-profile.js';
import { missingReplayIdentity } from './replay-readiness.js';
import type { ActorProxy, ActorResult, Outcome, OwnedDatabase, PendingUnit, RunOptions, RunResult, Scenario, TraceStep } from './types.js';

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
  if (options.plan?.some(actor => !names.includes(actor))) throw new TypeError('plan contains an unknown actor');
  if (Buffer.byteLength(JSON.stringify(options.plan ?? [])) > maxEvidenceBytes / 2) throw new TypeError('Initial schedule exceeds the evidence byte limit');
  const mode = options.mode ?? (options.replay ? 'replay' : 'explore');
  if (mode === 'replay' && !options.replay) throw new TypeError('replay mode requires a recorded run');
  if (options.replay) {
    const recorded = parseRunArtifact(options.replay);
    if (mode === 'replay') assertCompletedRun(recorded);
  }
  const recordedProtocol = options.replay?.limits.protocolProfile ?? 'sync-cycle-v1';
  const protocolProfile = resolveProtocolProfile(options.protocolProfile, mode === 'replay' ? recordedProtocol : undefined);
  if (options.maxConnectionsPerActor !== undefined && !Number.isSafeInteger(options.maxConnectionsPerActor)) {
    throw new TypeError('maxConnectionsPerActor must be an integer from 1 to 8');
  }
  const maxConnectionsPerActor = limit(options.maxConnectionsPerActor,
    mode === 'replay' ? options.replay!.limits.maxConnectionsPerActor ?? 1 : 1, 8, 'maxConnectionsPerActor');
  const replayConnections = new Map((options.replay?.connections ?? []).map(item => [`${item.actor}\0${item.connection}`, item]));
  const expectedEnvironment = mode === 'replay' ? options.replay!.environment : mode === 'guided' ? undefined : options.expectedEnvironment;
  const fixtureProfile = resolveFixtureProfile(options.fixtureProfile, expectedEnvironment?.fixture);
  const started = performance.now();
  const controller = new AbortController();
  const result: RunResult = {
    schemaVersion: protocolProfile === 'describe-flush-v1' ? 2 : 1, scenario: scenario.name, outcome: 'harness-error', mode,
    plan: [...(options.plan ?? [])], trace: [], actors: [], connections: [],
    environment: { serverVersion: 'unknown', nodeVersion: process.version, ...(source ? { source } : {}) },
    startedAt: new Date().toISOString(), durationMs: 0,
    limits: { maxSteps, timeoutMs, maxEvidenceBytes, maxConnectionsPerActor,
      ...(protocolProfile === 'describe-flush-v1' ? { protocolProfile } : {}) }, cleanup: { complete: false },
  };
  let database: OwnedDatabase | undefined = providedDatabase;
  let failure: Interrupted | undefined;
  let creationCleanupError: string | undefined;
  let finished = false;
  let applicationRejected = false;
  const proxies: ActorProxy[] = [];
  const actors: Promise<void>[] = [];
  const settled = new Map<string, ActorResult>();
  const queues = new Map(names.map(name => [name, [] as PendingUnit[]]));
  const running = new Map<string, { step: TraceStep; blocked: boolean }>();
  const pids = new Map<number, string>();
  const connectionPids = new Map<string, number>();
  const livePids = new Set<number>();
  const waiters = new Set<() => void>();
  let lastActor: string | undefined;
  let runtimeEpoch = 0;
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
  const deadline = setTimeout(() => stop('inconclusive', `Execution exceeded its ${timeoutMs} ms deadline`), timeoutMs);

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
    if (expectedEnvironment?.fixture && fixtureProfile !== recordedFixtureProfile(expectedEnvironment.fixture)) {
      throw new Interrupted('incompatible', 'Replay fixture profile differs from the recorded run');
    }
    // Creation has its own bounded cleanup. Retain the result before applying the run deadline.
    database ??= await createOwnedDatabase(options.databaseUrl);
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
    await bounded(scenario.setup({ db: database.db, connectionString: database.connectionString }));
    try {
      const fixture = await captureFixtureIdentity(database.connectionString, {
        profile: fixtureProfile,
        timeoutMs: Math.max(1, Math.min(120_000, Math.floor(timeoutMs - (performance.now() - started)))),
        ...(options.signal ? { signal: options.signal } : {}),
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
        actor, upstreamUrl: database.connectionString, maxConnectionsPerActor, protocolProfile,
        onUnit(unit) {
          if (finished) return;
          queues.get(actor)!.push(unit);
          wake();
        },
        onEvent(event) {
          if (finished) return;
          if (event.type === 'startup') {
            const identity = { actor: event.actor, connection: event.connection, fingerprint: event.fingerprint };
            if (retain(identity)) result.connections!.push(identity);
            if (mode === 'replay') {
              const original = replayConnections.get(`${event.actor}\0${event.connection}`);
              if (!original || original.fingerprint !== event.fingerprint) stop('incompatible', `Replay actor startup identity changed for ${event.actor} connection ${event.connection}`);
            }
            wake();
            return;
          }
          const key = `${actor}\0${event.connection}`;
          if (event.type === 'connected') {
            pids.set(event.backendPid, actor); livePids.add(event.backendPid); connectionPids.set(key, event.backendPid);
          } else {
            const pid = connectionPids.get(key);
            if (pid !== undefined) livePids.delete(pid);
            connectionPids.delete(key);
          }
          runtimeEpoch++;
          wake();
        },
        onError(error) { if (!finished) stop('inconclusive', `${actor}: ${message(error)}`); },
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

    executionLoop: while (settled.size < names.length || running.size || [...queues.values()].some(queue => queue.length)) {
      check();
      // Monitor actual backend wait state. Polling cadence never itself declares a lock.
      const sampledEpoch = runtimeEpoch;
      for (const [actor, state] of [...running]) {
        const observation = await bounded(database.observeWait(state.step.backendPid));
        // A completed or disconnected blocker invalidates every earlier sample in this batch.
        if (sampledEpoch !== runtimeEpoch) continue executionLoop;
        if (running.get(actor) !== state) continue;
        state.blocked = false;
        if (observation) {
          const ownBlockers = observation.blockerPids.every(pid => livePids.has(pid));
          if (!ownBlockers) throw new Interrupted('inconclusive', `${actor} is waiting for a lock outside the scheduled actors`);
          state.blocked = true;
          const previous = state.step.waits.at(-1);
          if ((!previous || JSON.stringify(previous) !== JSON.stringify(observation)) && retain(observation)) state.step.waits.push(observation);
        }
      }
      if ([...running.values()].some(state => !state.blocked)) { await pause(); continue; }
      const allReady = names.every(actor => settled.has(actor) || running.has(actor) || queues.get(actor)!.length > 0);
      if (!allReady) { await pause(); continue; }
      const available = names.filter(actor => !running.has(actor) && queues.get(actor)!.length > 0);
      if (!available.length) { await pause(); continue; }
      if (result.trace.length >= maxSteps) throw new Interrupted('inconclusive', `Execution reached its ${maxSteps}-step limit`);
      const expected = mode === 'replay' ? options.replay!.trace[result.trace.length] : undefined;
      if (mode === 'replay' && !expected) throw new Interrupted('incompatible', 'Application emitted more queries than the replay contains');
      const requested = expected?.actor ?? options.plan?.[result.trace.length];
      if (requested && !available.includes(requested)) {
        throw new Interrupted('incompatible', `Schedule asks for ${requested}, which cannot issue its next query at step ${result.trace.length}`);
      }
      const nextIndex = lastActor === undefined ? 0 : (names.indexOf(lastActor) + 1) % names.length;
      const fair = [...names.slice(nextIndex), ...names.slice(0, nextIndex)].find(actor => available.includes(actor))!;
      const actor = requested ?? fair;
      const unit = queues.get(actor)!.shift()!;
      if (Buffer.byteLength(unit.sql) > ARTIFACT_LIMITS.maxSqlBytes) throw new Interrupted('inconclusive', 'SQL exceeds the supported evidence byte limit');
      if (expected && (expected.actor !== unit.actor || expected.connection !== unit.connection || expected.ordinal !== unit.ordinal || expected.protocol !== unit.protocol || expected.sql !== unit.sql || expected.fingerprint !== unit.fingerprint)) {
        throw new Interrupted('incompatible', `Replay query or actor startup identity changed for ${actor} at step ${result.trace.length}`);
      }
      const stage = unit.stage ?? 'complete';
      const cycle = unit.cycle ?? unit.ordinal;
      if (expected && ((expected.stage ?? 'complete') !== stage || (expected.cycle ?? expected.ordinal) !== cycle || expected.prefixOrdinal !== unit.prefixOrdinal)) {
        throw new Interrupted('incompatible', `Replay protocol stage changed for ${actor} at step ${result.trace.length}`);
      }
      const step: TraceStep = {
        index: result.trace.length, actor, connection: unit.connection, ordinal: unit.ordinal,
        protocol: unit.protocol, sql: unit.sql, fingerprint: unit.fingerprint, backendPid: unit.backendPid,
        available, releasedAt: performance.now() - started, waits: [],
        ...(protocolProfile === 'describe-flush-v1' ? { stage, cycle,
          ...(unit.prefixOrdinal === undefined ? {} : { prefixOrdinal: unit.prefixOrdinal }) } : {}),
      };
      if (!retain(step)) { check(); }
      result.trace.push(step);
      lastActor = actor;
      const state = { step, blocked: false };
      running.set(actor, state);
      runtimeEpoch++;
      unit.release().then(completion => {
        if (retain(completion)) {
          step.completedAt = performance.now() - started;
          step.completion = protocolProfile === 'describe-flush-v1' && completion.kind !== 'metadata'
            ? { ...completion, kind: 'ready' } : completion;
        }
        running.delete(actor);
        runtimeEpoch++;
        wake();
      }, error => {
        running.delete(actor);
        runtimeEpoch++;
        if (!finished) stop('inconclusive', `${actor} query did not complete: ${message(error)}`);
        wake();
      });
    }
    check();
    if (mode === 'replay' && result.connections!.length !== options.replay!.connections!.length) throw new Interrupted('incompatible', 'Application finished before consuming every recorded actor connection');
    if (mode === 'replay' && result.trace.length !== options.replay!.trace.length) throw new Interrupted('incompatible', 'Application finished before consuming every replay step');
    if (mode !== 'replay' && (options.plan?.length ?? 0) > result.trace.length) throw new Interrupted('incompatible', 'Application finished before consuming every requested schedule choice');
    if (mode === 'replay') {
      const originalPids = new Map(options.replay!.trace.map(step => [step.backendPid, step.actor]));
      for (const step of result.trace) {
        const recorded = options.replay!.trace[step.index]!;
        const describeWaits = (item: TraceStep, identities: Map<number, string>): string => {
          const observations = item.waits.map(wait => JSON.stringify({
            type: wait.waitEventType, event: wait.waitEvent,
            blockers: [...new Set(wait.blockerPids.map(pid => identities.get(pid) ?? 'unknown'))].sort(),
          }));
          return JSON.stringify([...new Set(observations)].sort());
        };
        if (describeWaits(recorded, originalPids) !== describeWaits(step, pids)) {
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
        await bounded(scenario.invariant({ db: database.db, connectionString: database.connectionString, results: result.actors }));
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
    result.reason = applicationRejected
      ? message(`One or more application operations rejected before execution was interrupted; ${message(error)}`)
      : message(error);
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
