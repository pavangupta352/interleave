import { assertScenarioName } from './scenario.js';
import { validateSourceIdentity } from './source-schema.js';
import type {
  ActorResult,
  ConnectionIdentity,
  Failure,
  MetadataCompletion,
  RunResult,
  TraceStep,
  UnitCompletion,
  WaitObservation,
} from './types.js';

/** @internal Shared capture/serialization ceilings; keep out of the package-root API. */
export const ARTIFACT_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxSqlBytes: 1024 * 1024,
  maxGeneralStringBytes: 64 * 1024,
  maxJsonDepth: 100,
  maxJsonNodes: 200_000,
  maxEvidenceBytes: 12 * 1024 * 1024,
});

const MAX_ARTIFACT_BYTES = ARTIFACT_LIMITS.maxBytes;
const MAX_GENERAL_STRING_BYTES = ARTIFACT_LIMITS.maxGeneralStringBytes;
const MAX_SQL_BYTES = ARTIFACT_LIMITS.maxSqlBytes;
const MAX_ARRAY_ITEMS = 100_000;
const MAX_ACTORS = 8;
const MAX_AVAILABLE_ACTORS = 8;
const MAX_WAITS_PER_STEP = 10_000;
const MAX_COMMAND_TAGS = 10_000;
const MAX_BLOCKER_PIDS = 10_000;
const MAX_JSON_DEPTH = ARTIFACT_LIMITS.maxJsonDepth;
const MAX_JSON_NODES = ARTIFACT_LIMITS.maxJsonNodes;
const ACTOR_VALUE_WRAPPER_DEPTH = 3;

const ACTOR_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const ROOT_KEYS = [
  'schemaVersion', 'scenario', 'outcome', 'mode', 'plan', 'connections', 'trace', 'actors',
  'failure', 'reason', 'environment', 'startedAt', 'durationMs', 'limits', 'cleanup',
] as const;
const REQUIRED_ROOT_KEYS = [
  'schemaVersion', 'scenario', 'outcome', 'mode', 'plan', 'trace', 'actors',
  'environment', 'startedAt', 'durationMs', 'limits', 'cleanup',
] as const;

export interface WriteRunArtifactOptions {
  overwrite?: boolean;
}

export interface JsonValueValidationOptions {
  maxBytes?: number;
}

/** Rejects values that JSON serialization would omit, coerce, execute, or recurse forever. */
export function validateJsonValue(value: unknown, options: JsonValueValidationOptions = {}): void {
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) {
    throw new TypeError(`maxBytes must be a safe integer from 1 to ${MAX_ARTIFACT_BYTES}`);
  }
  assertJsonSafe(
    value,
    '$',
    new WeakSet<object>(),
    ACTOR_VALUE_WRAPPER_DEPTH,
    { nodes: 0, stringBytes: 0, maxStringBytes: maxBytes },
  );
}

export function parseRunArtifact(input: unknown): RunResult {
  let value = input;
  if (typeof input === 'string') {
    assertByteLength(input, MAX_ARTIFACT_BYTES, 'Run artifact');
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      throw new TypeError(`Run artifact contains invalid JSON: ${errorMessage(error)}`);
    }
  }

  // This bounded preflight makes every later schema walk operate on an already
  // capped graph, including repeated references supplied through the direct API.
  assertJsonSafe(value, '$');

  const root = shape(value, '$', ROOT_KEYS, REQUIRED_ROOT_KEYS);
  const version = field(root, 'schemaVersion', '$');
  if (version !== 1 && version !== 2) {
    throw new TypeError('$.schemaVersion: unsupported run artifact version; expected 1 or 2');
  }
  const scenario = field(root, 'scenario', '$');
  assertScenarioName(scenario, '$.scenario');
  const outcome = enumValue(field(root, 'outcome', '$'), '$.outcome', [
    'passed', 'violation', 'actor-error', 'incompatible', 'inconclusive', 'harness-error',
  ]);
  enumValue(field(root, 'mode', '$'), '$.mode', ['explore', 'replay', 'guided']);
  const durationMs = finiteNumber(field(root, 'durationMs', '$'), '$.durationMs', 0);

  const plan = arrayValue(field(root, 'plan', '$'), '$.plan', MAX_ARRAY_ITEMS);
  const planActors: string[] = [];
  const allActorNames = new Set<string>();
  for (let index = 0; index < plan.length; index += 1) {
    const actor = actorId(plan[index], `$.plan[${index}]`);
    planActors.push(actor);
    allActorNames.add(actor);
  }

  let connections: ConnectionIdentity[] | undefined;
  if (version === 2) field(root, 'connections', '$');
  const connectionKeys = new Set<string>();
  if (hasOwn(root, 'connections')) {
    const connectionValues = arrayValue(root.connections, '$.connections', MAX_ARRAY_ITEMS);
    connections = [];
    const lastConnectionByActor = new Map<string, number>();
    for (let index = 0; index < connectionValues.length; index += 1) {
      const path = `$.connections[${index}]`;
      const identity = shape(
        connectionValues[index],
        path,
        ['actor', 'connection', 'fingerprint'],
        ['actor', 'connection', 'fingerprint'],
      );
      const actor = actorId(identity.actor, `${path}.actor`);
      const connection = safeInteger(identity.connection, `${path}.connection`, 0);
      const fingerprint = fingerprintValue(identity.fingerprint, `${path}.fingerprint`);
      const previous = lastConnectionByActor.get(actor);
      if (previous !== undefined && connection <= previous) {
        throw new TypeError(`${path}.connection: actor connection generations must be strictly increasing`);
      }
      const key = `${actor}\0${connection}`;
      if (connectionKeys.has(key)) {
        throw new TypeError(`${path}: duplicate actor connection identity`);
      }
      connectionKeys.add(key);
      lastConnectionByActor.set(actor, connection);
      allActorNames.add(actor);
      connections.push({ actor, connection, fingerprint });
    }
  }

  const traceValues = arrayValue(field(root, 'trace', '$'), '$.trace', MAX_ARRAY_ITEMS);
  const ordinalByConnection = new Map<string, number>();
  const trace: TraceStep[] = [];
  for (let index = 0; index < traceValues.length; index += 1) {
    const step = validateTraceStep(traceValues[index], index, version);
    if (connections !== undefined && !connectionKeys.has(`${step.actor}\0${step.connection}`)) {
      throw new TypeError(`$.trace[${index}]: command references an unrecorded actor startup`);
    }
    const ordinalKey = `${step.actor}\0${step.connection}`;
    const expectedOrdinal = ordinalByConnection.get(ordinalKey) ?? 0;
    if (step.ordinal !== expectedOrdinal) {
      throw new TypeError(
        `$.trace[${index}].ordinal: expected ${expectedOrdinal} for actor ${step.actor} connection ${step.connection}`,
      );
    }
    ordinalByConnection.set(ordinalKey, expectedOrdinal + 1);
    trace.push(step);
    allActorNames.add(step.actor);
    for (const availableActor of step.available) allActorNames.add(availableActor);
  }

  for (let index = 0; index < trace.length; index += 1) {
    const step = trace[index]!;
    if (index > 0 && step.releasedAt < trace[index - 1]!.releasedAt) {
      throw new TypeError(`$.trace[${index}].releasedAt: release timestamps must be nondecreasing`);
    }
    if (step.releasedAt > durationMs) {
      throw new TypeError(`$.trace[${index}].releasedAt: cannot exceed run durationMs`);
    }
    if (step.completedAt !== undefined && step.completedAt > durationMs) {
      throw new TypeError(`$.trace[${index}].completedAt: cannot exceed run durationMs`);
    }
  }

  const actorsByBackendPid = new Map<number, Set<string>>();
  for (const step of trace) {
    const actors = actorsByBackendPid.get(step.backendPid) ?? new Set<string>();
    actors.add(step.actor);
    actorsByBackendPid.set(step.backendPid, actors);
  }
  for (let stepIndex = 0; stepIndex < trace.length; stepIndex += 1) {
    const step = trace[stepIndex]!;
    for (let waitIndex = 0; waitIndex < step.waits.length; waitIndex += 1) {
      const wait = step.waits[waitIndex]!;
      for (let blockerIndex = 0; blockerIndex < wait.blockerPids.length; blockerIndex += 1) {
        const blockerPid = wait.blockerPids[blockerIndex]!;
        const blockerActors = actorsByBackendPid.get(blockerPid);
        const blockerPath = `$.trace[${stepIndex}].waits[${waitIndex}].blockerPids[${blockerIndex}]`;
        if (blockerPid === step.backendPid) {
          throw new TypeError(`${blockerPath}: a waiting backend cannot block itself`);
        }
        if (blockerActors === undefined) {
          throw new TypeError(`${blockerPath}: blocker pid is absent from the released trace`);
        }
        if (![...blockerActors].some(actor => actor !== step.actor)) {
          throw new TypeError(`${blockerPath}: blocker pid must belong to a different actor`);
        }
      }
    }
  }

  const actorValues = arrayValue(field(root, 'actors', '$'), '$.actors', MAX_ACTORS);
  const actorNames = new Set<string>();
  let rejectedActors = 0;
  for (let index = 0; index < actorValues.length; index += 1) {
    const actor = validateActorResult(actorValues[index], index);
    if (actorNames.has(actor.actor)) {
      throw new TypeError(`$.actors[${index}].actor: duplicate actor id ${actor.actor}`);
    }
    actorNames.add(actor.actor);
    allActorNames.add(actor.actor);
    if (actor.status === 'rejected') rejectedActors += 1;
  }
  if (allActorNames.size > MAX_ACTORS) {
    throw new TypeError('Run artifact cannot name more than 8 actors across plan, connections, trace, and results');
  }
  const requiresCompleteActors = outcome === 'passed' || outcome === 'violation' || outcome === 'actor-error';
  if (version === 2) validateStageSequence(trace, requiresCompleteActors);
  if (requiresCompleteActors && actorNames.size < 2) {
    throw new TypeError('$.actors: completed executions require at least two actor results');
  }
  if (requiresCompleteActors) {
    for (let index = 0; index < planActors.length; index += 1) {
      if (!actorNames.has(planActors[index]!)) {
        throw new TypeError(`$.plan[${index}]: actor is absent from recorded actor results`);
      }
    }
    for (let index = 0; index < trace.length; index += 1) {
      const step = trace[index]!;
      if (!actorNames.has(step.actor)) {
        throw new TypeError(`$.trace[${index}].actor: actor is absent from recorded actor results`);
      }
      for (let availableIndex = 0; availableIndex < step.available.length; availableIndex += 1) {
        if (!actorNames.has(step.available[availableIndex]!)) {
          throw new TypeError(
            `$.trace[${index}].available[${availableIndex}]: actor is absent from recorded actor results`,
          );
        }
      }
    }
    if (connections !== undefined) {
      for (let index = 0; index < connections.length; index += 1) {
        if (!actorNames.has(connections[index]!.actor)) {
          throw new TypeError(`$.connections[${index}].actor: actor is absent from recorded actor results`);
        }
      }
    }
  }
  if ((outcome === 'passed' || outcome === 'violation') && rejectedActors !== 0) {
    throw new TypeError(`$.actors: ${outcome} outcomes require every actor to be fulfilled`);
  }
  if (outcome === 'actor-error' && rejectedActors === 0) {
    throw new TypeError('$.actors: actor-error outcomes require at least one rejected actor');
  }

  if (hasOwn(root, 'failure')) {
    validateFailure(root.failure, '$.failure');
    if (outcome !== 'violation') {
      throw new TypeError('$.failure: failure evidence is only valid for a violation outcome');
    }
  } else if (outcome === 'violation') {
    throw new TypeError('$.failure: violation outcomes require failure evidence');
  }
  if (hasOwn(root, 'reason')) {
    boundedString(root.reason, '$.reason', 0, MAX_GENERAL_STRING_BYTES);
  }

  const environment = shape(
    field(root, 'environment', '$'),
    '$.environment',
    ['serverVersion', 'nodeVersion', 'fixture', 'source'],
    ['serverVersion', 'nodeVersion'],
  );
  const serverVersion = boundedString(environment.serverVersion, '$.environment.serverVersion', 1, 256);
  boundedString(environment.nodeVersion, '$.environment.nodeVersion', 1, 256);
  if (hasOwn(environment, 'fixture')) {
    const profile = validateFixtureIdentity(environment.fixture, '$.environment.fixture');
    const serverMajor = /^(16|17|18)(?:\.|\s|$)/.exec(serverVersion)?.[1];
    const matches = profile === `postgresql${serverMajor}-native-v1` || (serverMajor === '17' && profile === 'postgresql17-pgvector0.8.6-v1');
    if (!serverMajor || !matches) {
      throw new TypeError('$.environment.fixture.profile: fixture profile contradicts the recorded PostgreSQL server major');
    }
  }
  if (hasOwn(environment, 'source')) validateSourceIdentity(environment.source, '$.environment.source');

  validateTimestamp(field(root, 'startedAt', '$'), '$.startedAt');

  const limits = shape(
    field(root, 'limits', '$'),
    '$.limits',
    ['maxSteps', 'timeoutMs', 'maxEvidenceBytes', 'maxConnectionsPerActor', ...(version === 2 ? ['protocolProfile'] : [])],
    ['maxSteps', 'timeoutMs', ...(version === 2 ? ['protocolProfile'] : [])],
  );
  if (version === 2 && limits.protocolProfile !== 'describe-flush-v1') {
    throw new TypeError('$.limits.protocolProfile: version 2 requires describe-flush-v1');
  }
  safeInteger(limits.maxSteps, '$.limits.maxSteps', 1);
  safeInteger(limits.timeoutMs, '$.limits.timeoutMs', 1);
  if (hasOwn(limits, 'maxConnectionsPerActor') && safeInteger(limits.maxConnectionsPerActor, '$.limits.maxConnectionsPerActor', 1) > 8) {
    throw new TypeError('$.limits.maxConnectionsPerActor: cannot exceed 8');
  }
  if (hasOwn(limits, 'maxEvidenceBytes')) {
    const maxEvidenceBytes = safeInteger(limits.maxEvidenceBytes, '$.limits.maxEvidenceBytes', 1024);
    if (maxEvidenceBytes > ARTIFACT_LIMITS.maxEvidenceBytes) {
      throw new TypeError(
        `$.limits.maxEvidenceBytes: cannot exceed ${ARTIFACT_LIMITS.maxEvidenceBytes}`,
      );
    }
  }

  const cleanup = shape(
    field(root, 'cleanup', '$'),
    '$.cleanup',
    ['complete', 'error'],
    ['complete'],
  );
  const cleanupComplete = booleanValue(cleanup.complete, '$.cleanup.complete');
  const cleanupHasError = hasOwn(cleanup, 'error');
  if (cleanupComplete === cleanupHasError) {
    throw new TypeError(
      '$.cleanup: complete cleanup must omit error and incomplete cleanup must include error',
    );
  }
  if (cleanupHasError) {
    boundedString(cleanup.error, '$.cleanup.error', 0, MAX_GENERAL_STRING_BYTES);
  }

  assertSerializedSize(root);
  return root as unknown as RunResult;
}

function validateTraceStep(value: unknown, index: number, version: 1 | 2): TraceStep {
  const path = `$.trace[${index}]`;
  const step = shape(value, path, [
    'index', 'actor', 'connection', 'ordinal', 'protocol', 'sql', 'fingerprint',
    'backendPid', 'available', 'releasedAt', 'completedAt', 'completion', 'waits',
    ...(version === 2 ? ['stage', 'cycle', 'prefixOrdinal'] : []),
  ], [
    'index', 'actor', 'connection', 'ordinal', 'protocol', 'sql', 'fingerprint',
    'backendPid', 'available', 'releasedAt', 'waits',
    ...(version === 2 ? ['stage', 'cycle'] : []),
  ]);

  const stepIndex = safeInteger(step.index, `${path}.index`, 0);
  if (stepIndex !== index) {
    throw new TypeError(`${path}.index: expected zero-based trace index ${index}`);
  }
  const actor = actorId(step.actor, `${path}.actor`);
  const connection = safeInteger(step.connection, `${path}.connection`, 0);
  const ordinal = safeInteger(step.ordinal, `${path}.ordinal`, 0);
  const protocol = enumValue(step.protocol, `${path}.protocol`, ['simple', 'extended']);
  const sql = boundedString(step.sql, `${path}.sql`, 0, MAX_SQL_BYTES, true);
  const fingerprint = fingerprintValue(step.fingerprint, `${path}.fingerprint`);
  const backendPid = safeInteger(step.backendPid, `${path}.backendPid`, 1);
  const stage = version === 2 ? enumValue(step.stage, `${path}.stage`, ['complete', 'describe', 'execute', 'recover']) : undefined;
  const cycle = version === 2 ? safeInteger(step.cycle, `${path}.cycle`, 0) : undefined;
  let prefixOrdinal: number | undefined;
  if (stage === 'execute' || stage === 'recover') {
    prefixOrdinal = safeInteger(field(step, 'prefixOrdinal', path), `${path}.prefixOrdinal`, 0);
  } else if (hasOwn(step, 'prefixOrdinal')) {
    throw new TypeError(`${path}.prefixOrdinal: only execute and recover stages may reference a prefix`);
  }
  if (stage !== undefined && stage !== 'complete' && protocol !== 'extended') {
    throw new TypeError(`${path}.protocol: staged metadata and continuations require the extended protocol`);
  }

  const availableValues = arrayValue(step.available, `${path}.available`, MAX_AVAILABLE_ACTORS);
  if (availableValues.length === 0) {
    throw new TypeError(`${path}.available: expected at least the selected actor`);
  }
  const available = availableValues.map((item, itemIndex) => actorId(item, `${path}.available[${itemIndex}]`));
  if (new Set(available).size !== available.length) {
    throw new TypeError(`${path}.available: duplicate actor ids are not allowed`);
  }
  if (!available.includes(actor)) {
    throw new TypeError(`${path}.available: must include selected actor ${actor}`);
  }

  const releasedAt = finiteNumber(step.releasedAt, `${path}.releasedAt`, 0);
  const hasCompletedAt = hasOwn(step, 'completedAt');
  const hasCompletion = hasOwn(step, 'completion');
  if (hasCompletedAt !== hasCompletion) {
    throw new TypeError(`${path}: completedAt and completion must appear together`);
  }
  let completedAt: number | undefined;
  if (hasCompletedAt) {
    completedAt = finiteNumber(step.completedAt, `${path}.completedAt`, releasedAt);
  }
  let completion: UnitCompletion | undefined;
  if (hasCompletion) {
    completion = validateCompletion(step.completion, `${path}.completion`, version, stage === 'describe');
    if (stage === 'recover' && completion.kind !== 'metadata' && (completion.commandTags.length !== 0 || completion.rowCount !== 0)) {
      throw new TypeError(`${path}.completion: Sync-only recovery cannot complete executed commands or rows`);
    }
  }

  const waitValues = arrayValue(step.waits, `${path}.waits`, MAX_WAITS_PER_STEP);
  const waits = waitValues.map((wait, waitIndex) => validateWait(
    wait,
    `${path}.waits[${waitIndex}]`,
    backendPid,
  ));

  return {
    index: stepIndex,
    actor,
    connection,
    ordinal,
    protocol,
    sql,
    fingerprint,
    backendPid,
    ...(stage === undefined ? {} : { stage, cycle: cycle! }),
    ...(prefixOrdinal === undefined ? {} : { prefixOrdinal }),
    available,
    releasedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(completion === undefined ? {} : { completion }),
    waits,
  };
}

function validateCompletion(value: unknown, path: string, version: 1 | 2, metadata: boolean): UnitCompletion {
  if (metadata) return validateMetadataCompletion(value, path);
  const completion = shape(value, path, [
    'transactionStatus', 'commandTags', 'rowCount', 'error', ...(version === 2 ? ['kind'] : []),
  ], ['transactionStatus', 'commandTags', 'rowCount', ...(version === 2 ? ['kind'] : [])]);
  if (version === 2 && completion.kind !== 'ready') throw new TypeError(`${path}.kind: expected ready completion`);
  const transactionStatus = enumValue(
    completion.transactionStatus,
    `${path}.transactionStatus`,
    ['I', 'T', 'E'],
  );
  const commandTagValues = arrayValue(completion.commandTags, `${path}.commandTags`, MAX_COMMAND_TAGS);
  const commandTags = commandTagValues.map((tag, index) => boundedString(
    tag,
    `${path}.commandTags[${index}]`,
    0,
    1024,
  ));
  const rowCount = safeInteger(completion.rowCount, `${path}.rowCount`, 0);
  let error: UnitCompletion['error'];
  if (hasOwn(completion, 'error')) {
    const errorValue = shape(completion.error, `${path}.error`, ['code', 'message'], ['code', 'message']);
    const code = boundedString(errorValue.code, `${path}.error.code`, 5, 5);
    if (!SQLSTATE.test(code)) {
      throw new TypeError(`${path}.error.code: expected a five-character SQLSTATE`);
    }
    error = {
      code,
      message: boundedString(errorValue.message, `${path}.error.message`, 0, MAX_GENERAL_STRING_BYTES),
    };
  }
  return { ...(version === 2 ? { kind: 'ready' as const } : {}), transactionStatus, commandTags, rowCount, ...(error === undefined ? {} : { error }) };
}

function validateMetadataCompletion(value: unknown, path: string): MetadataCompletion {
  const record = plainRecord(value, path);
  const result = enumValue(field(record, 'result', path), `${path}.result`, ['described', 'error']);
  const keys = result === 'described'
    ? ['kind', 'result', 'parameterCount', 'columnCount', 'resultShape']
    : ['kind', 'result', 'error'];
  const completion = shape(record, path, keys, keys);
  if (completion.kind !== 'metadata') throw new TypeError(`${path}.kind: expected metadata completion`);
  if (result === 'error') {
    const error = shape(completion.error, `${path}.error`, ['code', 'message'], ['code', 'message']);
    const code = boundedString(error.code, `${path}.error.code`, 5, 5);
    if (!SQLSTATE.test(code)) throw new TypeError(`${path}.error.code: expected a five-character SQLSTATE`);
    return { kind: 'metadata', result, error: { code,
      message: boundedString(error.message, `${path}.error.message`, 0, MAX_GENERAL_STRING_BYTES) } };
  }
  const parameterCount = safeInteger(completion.parameterCount, `${path}.parameterCount`, 0);
  const columnCount = safeInteger(completion.columnCount, `${path}.columnCount`, 0);
  if (parameterCount > 65_535 || columnCount > 65_535) throw new TypeError(`${path}: metadata count exceeds the protocol field limit`);
  const resultShape = enumValue(completion.resultShape, `${path}.resultShape`, ['rows', 'no-data']);
  if (resultShape === 'no-data' && columnCount !== 0) throw new TypeError(`${path}.columnCount: NoData metadata cannot describe columns`);
  return { kind: 'metadata', result, parameterCount, columnCount, resultShape };
}

function validateStageSequence(trace: TraceStep[], complete: boolean): void {
  const cycles = new Map<string, { next: number; prefix?: TraceStep; previous?: TraceStep }>();
  const actorCycles = new Map<string, { connection: number; completedAt?: number }>();
  for (const step of trace) {
    const path = `$.trace[${step.index}]`;
    const active = actorCycles.get(step.actor);
    if (active?.completedAt !== undefined && active.completedAt <= step.releasedAt) actorCycles.delete(step.actor);
    else if (active && active.connection !== step.connection) {
      throw new TypeError(`${path}.connection: another command connection cannot enter an actor's open staged cycle`);
    }
    const key = `${step.actor}\0${step.connection}`;
    const state = cycles.get(key) ?? { next: 0 };
    if (state.previous && (state.previous.completedAt === undefined || state.previous.completedAt > step.releasedAt)) {
      throw new TypeError(`${path}: a connection cannot release another stage before its preceding stage completes`);
    }
    if (state.previous && state.previous.backendPid !== step.backendPid) {
      throw new TypeError(`${path}.backendPid: a connection generation must retain its backend identity`);
    }
    if (step.cycle !== state.next) throw new TypeError(`${path}.cycle: expected logical cycle ${state.next}`);
    if (step.stage === 'execute' || step.stage === 'recover') {
      const prefix = state.prefix;
      if (!prefix || prefix.ordinal !== step.prefixOrdinal || prefix.backendPid !== step.backendPid || prefix.sql !== step.sql) {
        throw new TypeError(`${path}.prefixOrdinal: continuation must reference its own matching describe stage`);
      }
      const metadata = prefix.completion;
      if (metadata?.kind !== 'metadata') throw new TypeError(`${path}: prefix requires a completed metadata stage`);
      const required = metadata.result === 'error' ? 'recover' : 'execute';
      if (step.stage !== required) throw new TypeError(`${path}.stage: prefix metadata requires ${required}`);
      if (step.stage === 'recover' && metadata.result === 'error' && step.completion?.kind === 'ready') {
        if (step.completion.transactionStatus === 'T') throw new TypeError(`${path}.completion.transactionStatus: Sync-only error recovery cannot leave a healthy transaction open`);
        const error = step.completion.error;
        if (error && (error.code !== metadata.error.code || error.message !== metadata.error.message)) {
          throw new TypeError(`${path}.completion.error: retained recovery error must match its metadata prefix`);
        }
      }
      actorCycles.set(step.actor, { connection: step.connection,
        ...(step.completedAt === undefined ? {} : { completedAt: step.completedAt }) });
      delete state.prefix;
      state.next++;
    } else {
      if (state.prefix) throw new TypeError(`${path}: an open describe cycle requires its continuation`);
      if (step.stage === 'describe') {
        state.prefix = step;
        actorCycles.set(step.actor, { connection: step.connection });
      }
      else state.next++;
    }
    if (complete && !step.completion) throw new TypeError(`${path}: completed execution requires every released stage to complete`);
    state.previous = step;
    cycles.set(key, state);
  }
  if (complete && [...cycles.values()].some(state => state.prefix)) {
    throw new TypeError('$.trace: completed execution cannot leave an open describe cycle');
  }
}

function validateWait(value: unknown, path: string, backendPid: number): WaitObservation {
  const wait = shape(
    value,
    path,
    ['pid', 'blockerPids', 'waitEvent', 'waitEventType'],
    ['pid', 'blockerPids', 'waitEvent', 'waitEventType'],
  );
  const pid = safeInteger(wait.pid, `${path}.pid`, 1);
  if (pid !== backendPid) {
    throw new TypeError(`${path}.pid: expected trace backendPid ${backendPid}`);
  }
  const blockerValues = arrayValue(wait.blockerPids, `${path}.blockerPids`, MAX_BLOCKER_PIDS);
  if (blockerValues.length === 0) {
    throw new TypeError(`${path}.blockerPids: lock waits require at least one blocker`);
  }
  const blockerPids = blockerValues.map((blocker, index) => safeInteger(
    blocker,
    `${path}.blockerPids[${index}]`,
    1,
  ));
  if (new Set(blockerPids).size !== blockerPids.length) {
    throw new TypeError(`${path}.blockerPids: duplicate pids are not allowed`);
  }
  if (wait.waitEventType !== 'Lock') {
    throw new TypeError(`${path}.waitEventType: recorded wait evidence must be a Lock`);
  }
  return {
    pid,
    blockerPids,
    waitEvent: boundedString(wait.waitEvent, `${path}.waitEvent`, 1, 256),
    waitEventType: boundedString(wait.waitEventType, `${path}.waitEventType`, 1, 256),
  };
}

function validateActorResult(value: unknown, index: number): ActorResult {
  const path = `$.actors[${index}]`;
  const actorResult = shape(value, path, ['actor', 'status', 'value', 'error'], ['actor', 'status']);
  const actor = actorId(actorResult.actor, `${path}.actor`);
  const status = enumValue(actorResult.status, `${path}.status`, ['fulfilled', 'rejected']);
  if (status === 'fulfilled') {
    if (hasOwn(actorResult, 'error')) {
      throw new TypeError(`${path}.error: fulfilled actor results cannot contain an error`);
    }
    if (hasOwn(actorResult, 'value')) {
      assertJsonSafe(actorResult.value, `${path}.value`, new WeakSet<object>(), ACTOR_VALUE_WRAPPER_DEPTH);
    }
  } else {
    if (hasOwn(actorResult, 'value')) {
      throw new TypeError(`${path}.value: rejected actor results cannot contain a value`);
    }
    boundedString(field(actorResult, 'error', path), `${path}.error`, 0, MAX_GENERAL_STRING_BYTES);
  }
  return actorResult as unknown as ActorResult;
}

function validateFailure(value: unknown, path: string): Failure {
  const failure = shape(value, path, ['name', 'message', 'fingerprint'], ['name', 'message', 'fingerprint']);
  return {
    name: boundedString(failure.name, `${path}.name`, 1, 256),
    message: boundedString(failure.message, `${path}.message`, 0, MAX_GENERAL_STRING_BYTES),
    fingerprint: fingerprintValue(failure.fingerprint, `${path}.fingerprint`),
  };
}

function assertJsonSafe(
  value: unknown,
  path: string,
  active = new WeakSet<object>(),
  depth = 0,
  counter: { nodes: number; stringBytes: number; maxStringBytes: number } = {
    nodes: 0,
    stringBytes: 0,
    maxStringBytes: MAX_ARTIFACT_BYTES,
  },
): void {
  counter.nodes += 1;
  if (counter.nodes > MAX_JSON_NODES) {
    throw new TypeError(`${path}: serialized value exceeds the JSON node limit`);
  }
  if (depth > MAX_JSON_DEPTH) {
    throw new TypeError(`${path}: serialized value exceeds the JSON depth limit`);
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertByteLength(value, MAX_SQL_BYTES, path);
    counter.stringBytes += utf8ByteLength(value, 'utf8');
    if (counter.stringBytes > counter.maxStringBytes) {
      throw new TypeError(`${path}: serialized value exceeds the ${counter.maxStringBytes} byte limit`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${path}: numbers must be finite and cannot be negative zero for exact JSON serialization`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path}: value is not JSON serializable`);
  }
  if (active.has(value)) {
    throw new TypeError(`${path}: cyclic values are not JSON serializable`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items = arrayValue(value, path, MAX_ARRAY_ITEMS);
      for (let index = 0; index < items.length; index += 1) {
        assertJsonSafe(items[index], `${path}[${index}]`, active, depth + 1, counter);
      }
      return;
    }
    const record = plainRecord(value, path);
    const keys = Object.keys(record);
    if (keys.length > MAX_ARRAY_ITEMS) {
      throw new TypeError(`${path}: object exceeds the property limit`);
    }
    for (const key of keys) {
      counter.stringBytes += utf8ByteLength(key, 'utf8');
      if (counter.stringBytes > counter.maxStringBytes) {
        throw new TypeError(`${path}: serialized value exceeds the ${counter.maxStringBytes} byte limit`);
      }
      assertJsonSafe(record[key], `${path}.${key}`, active, depth + 1, counter);
    }
  } finally {
    active.delete(value);
  }
}

function shape(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const record = plainRecord(value, path);
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${path}.${key}: unknown field`);
    }
  }
  for (const key of required) {
    field(record, key, path);
  }
  return record;
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: expected an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path}: objects with custom prototypes are not allowed`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${path}: symbol keys are not JSON serializable`);
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > MAX_ARRAY_ITEMS) {
    throw new TypeError(`${path}: object exceeds the property limit`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (PROTOTYPE_KEYS.has(key)) {
      throw new TypeError(`${path}.${key}: prototype-sensitive key is not allowed`);
    }
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${path}.${key}: expected an own enumerable data property`);
    }
  }
  return value as Record<string, unknown>;
}

function field(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!hasOwn(record, key)) {
    throw new TypeError(`${path}.${key}: required field is missing`);
  }
  return record[key];
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function arrayValue(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path}: expected an array`);
  }
  if (value.length > maximum) {
    throw new TypeError(`${path}: array exceeds the ${maximum} item limit`);
  }
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${path}[${index}]: sparse arrays and accessors are not JSON serializable`);
    }
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${path}: extra array properties are not JSON serializable`);
    }
  }
  return value;
}

function actorId(value: unknown, path: string): string {
  const actor = boundedString(value, path, 1, 48);
  if (!ACTOR_ID.test(actor) || PROTOTYPE_KEYS.has(actor)) {
    throw new TypeError(`${path}: invalid actor id`);
  }
  return actor;
}

function validateFixtureIdentity(value: unknown, path: string): string {
  const keys = ['version', 'profile', 'algorithm', 'fingerprint', 'components', 'counts'];
  const fixture = shape(value, path, keys, keys);
  if (fixture.version !== 1) throw new TypeError(`${path}.version: expected fixture identity version 1`);
  const profile = enumValue(fixture.profile, `${path}.profile`, [
    'postgresql16-native-v1', 'postgresql17-native-v1', 'postgresql18-native-v1',
    'postgresql17-pgvector0.8.6-v1',
  ]);
  enumValue(fixture.algorithm, `${path}.algorithm`, ['sha256']);
  fingerprintValue(fixture.fingerprint, `${path}.fingerprint`);
  const names = ['schema', 'data', 'sequences', 'settings'];
  const components = shape(fixture.components, `${path}.components`, names, names);
  for (const name of names) fingerprintValue(components[name], `${path}.components.${name}`);
  const counts = shape(fixture.counts, `${path}.counts`, ['objects', 'rows', 'bytes'], ['objects', 'rows', 'bytes']);
  for (const name of ['objects', 'rows', 'bytes']) safeInteger(counts[name], `${path}.counts.${name}`, 0);
  return profile;
}

function fingerprintValue(value: unknown, path: string): string {
  const fingerprint = boundedString(value, path, 64, 64);
  if (!FINGERPRINT.test(fingerprint)) {
    throw new TypeError(`${path}: expected a lowercase SHA-256 fingerprint`);
  }
  return fingerprint;
}

function boundedString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  bytes = false,
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${path}: expected a string`);
  }
  const length = bytes ? utf8ByteLength(value, 'utf8') : value.length;
  if (length < minimum || length > maximum) {
    throw new TypeError(`${path}: string length must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function enumValue<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${path}: expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function finiteNumber(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) || value < minimum) {
    throw new TypeError(`${path}: expected a finite number greater than or equal to ${minimum}`);
  }
  return value;
}

function safeInteger(value: unknown, path: string, minimum: number): number {
  const result = finiteNumber(value, path, minimum);
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${path}: expected a safe integer`);
  }
  return result;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${path}: expected a boolean`);
  }
  return value;
}

function assertByteLength(value: string, maximum: number, label: string): void {
  if (utf8ByteLength(value, 'utf8') > maximum) {
    throw new TypeError(`${label} exceeds the ${maximum === MAX_ARTIFACT_BYTES ? '16 MiB' : maximum} size limit`);
  }
}

function assertSerializedSize(value: Record<string, unknown>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`Run artifact is not JSON serializable: ${errorMessage(error)}`);
  }
  assertByteLength(serialized, MAX_ARTIFACT_BYTES, 'Run artifact');
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateTimestamp(value: unknown, path: string): string {
  const timestamp = boundedString(value, path, 1, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(timestamp);
  if (match === null) {
    throw new TypeError(`${path}: expected a valid UTC ISO-8601 timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || hour > 23 || minute > 59 || second > 59) {
    throw new TypeError(`${path}: expected a real UTC calendar timestamp`);
  }
  return timestamp;
}


function utf8ByteLength(value: string, _encoding?: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

/** @internal Shared with atomic artifact IO; omitted from the package-root API. */
export function validateArtifactWriteOptions(options: unknown): WriteRunArtifactOptions {
  const value = shape(options, 'options', ['overwrite'], []);
  if (hasOwn(value, 'overwrite')) booleanValue(value.overwrite, 'options.overwrite');
  return value as WriteRunArtifactOptions;
}
