import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createOwnedDatabase, OwnedDatabaseCreationError } from './database.js';
import { assertCompletedRun } from './completed-run.js';
import { parseRunArtifact } from './artifact.js';
import { assertEvidenceEnvelope, finalizeRunEvidence } from './evidence.js';
import { captureSourceIdentity, SourceIdentityError, type SourceIdentity } from './source-identity.js';
import { sourceSelection } from './source-selection.js';
import { resolveProtocolProfile } from './protocol-profile.js';
import { recordedFixtureProfile, resolveFixtureProfile } from './fixture-profile.js';
import { missingReplayIdentity } from './replay-readiness.js';
import { transportMatches } from './environment.js';
import { resolvePostgresTransport, runTransportIdentity } from './postgres-transport.js';
import { connectionFailureMessage } from './protocol/upstream-transport.js';
import { defaultConnectionLimit, recordedConnectionProfile, resolveConnectionProfile, resolveOverlap, validatePlanEntries } from './lanes.js';
import type { OwnedDatabase, RunOptions, RunResult } from './types.js';

const GRACE_MS = 250;
/** The parent's backstop fires this long after the worker's own execution deadline. */
const WORKER_DEADLINE_GRACE_MS = 1_000;
/** Each source identity capture, before and after execution, is bounded separately. */
const SOURCE_IDENTITY_TIMEOUT_MS = 60_000;

function limit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${label} must be an integer from 1 to ${maximum}`);
  return result;
}

/** Execute trusted local scenario code in a disposable process; retain database ownership here. */
export async function runScenarioFile(scenarioFile: string, options: RunOptions): Promise<RunResult> {
  if (typeof scenarioFile !== 'string' || !scenarioFile.trim()) throw new TypeError('An explicit local scenario file is required');
  if (!options.databaseUrl) throw new TypeError('databaseUrl must explicitly name a dedicated test PostgreSQL administrator connection');
  const maxSteps = limit(options.maxSteps, 100, 100_000, 'maxSteps');
  const timeoutMs = limit(options.timeoutMs, 10_000, 600_000, 'timeoutMs');
  const maxEvidenceBytes = limit(options.maxEvidenceBytes, 8 * 1024 * 1024, 12 * 1024 * 1024, 'maxEvidenceBytes');
  if (maxEvidenceBytes < 1024) throw new TypeError('maxEvidenceBytes must be at least 1024');
  const mode = options.mode ?? (options.replay ? 'replay' : 'explore');
  if (!['explore', 'replay', 'guided'].includes(mode)) throw new TypeError('Unknown execution mode');
  if (mode === 'replay' && !options.replay) throw new TypeError('replay mode requires a recorded run');
  if (options.replay) {
    const recorded = parseRunArtifact(options.replay);
    if (mode === 'replay') assertCompletedRun(recorded);
  }
  const recordedProtocol = options.replay?.limits.protocolProfile ?? 'sync-cycle-v1';
  const missingIdentity = mode === 'replay' ? missingReplayIdentity(options.replay!) : undefined;
  const protocolProfile = resolveProtocolProfile(options.protocolProfile, mode === 'replay' ? recordedProtocol : undefined);
  const protocolProfileMismatch = mode === 'replay' && protocolProfile !== recordedProtocol;
  const expectedEnvironment = mode === 'replay' ? options.replay!.environment : mode === 'guided' ? undefined : options.expectedEnvironment;
  const fixtureProfile = resolveFixtureProfile(options.fixtureProfile, expectedEnvironment?.fixture);
  const fixtureProfileMismatch = expectedEnvironment?.fixture !== undefined && fixtureProfile !== recordedFixtureProfile(expectedEnvironment.fixture);
  const recordedConnections = mode === 'replay' ? recordedConnectionProfile(options.replay!) : undefined;
  const connectionProfile = resolveConnectionProfile(options.connectionProfile, recordedConnections);
  const replayConnections = mode === 'replay' ? (options.replay!.limits.maxConnectionsPerActor ?? 1) : undefined;
  const maxConnectionsPerActor = limit(
    options.maxConnectionsPerActor === undefined ? replayConnections : options.maxConnectionsPerActor,
    defaultConnectionLimit(connectionProfile), 8, 'maxConnectionsPerActor',
  );
  const connectionProfileMismatch = mode === 'replay'
    && ((options.maxConnectionsPerActor !== undefined && options.maxConnectionsPerActor !== replayConnections)
      || connectionProfile !== recordedConnections);
  const recordedOverlap = mode === 'replay' ? options.replay!.limits.overlap : undefined;
  const overlap = resolveOverlap(options.overlap, recordedOverlap);
  const overlapMismatch = mode === 'replay' && overlap !== recordedOverlap;
  if (options.plan && (!Array.isArray(options.plan) || options.plan.length > 100_000)) throw new TypeError('plan contains an invalid actor');
  validatePlanEntries(options.plan, connectionProfile, undefined, overlap);
  // Resolve trust once; the parent and worker use this snapshot for every connection.
  const transport = resolvePostgresTransport(options.databaseUrl, options.upstreamTls);
  const started = performance.now();
  const multi = connectionProfile === 'multi-producer-v1';
  const result: RunResult = {
    schemaVersion: multi || overlap ? 4 : 3, scenario: basename(scenarioFile).slice(0, 256), outcome: 'harness-error', mode,
    plan: [...(options.plan ?? [])], trace: [], actors: [], connections: [],
    environment: { serverVersion: 'unknown', nodeVersion: process.version, transport: runTransportIdentity(transport) },
    startedAt: new Date().toISOString(), durationMs: 0,
    limits: { maxSteps, timeoutMs, maxEvidenceBytes, maxConnectionsPerActor, protocolProfile,
      ...(multi || overlap ? { connectionProfile } : {}), ...(overlap ? { overlap } : {}) },
    cleanup: { complete: false },
  };
  assertEvidenceEnvelope(result, maxEvidenceBytes);
  let database: OwnedDatabase | undefined;
  let creationFailure: OwnedDatabaseCreationError | undefined;
  let child: ChildProcess | undefined;
  let interruption: string | undefined;
  let workerFailure: string | undefined;
  let receivedHardFailure = false;
  let stopChild: (() => void) | undefined;
  const captureController = new AbortController();
  const interrupt = (reason: string): void => { interruption ??= reason; captureController.abort(); stopChild?.(); };
  const onAbort = (): void => interrupt('Execution was cancelled');
  // The execution deadline covers the database and worker. Source identity capture
  // before and after execution is evidence binding with its own bound, so a slow
  // capture on a loaded machine cannot consume the scenario's execution time.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (milliseconds = timeoutMs): void => {
    clearTimeout(deadline);
    deadline = setTimeout(() => interrupt(`Execution exceeded its ${timeoutMs} ms deadline`), milliseconds);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let sourceIdentity: SourceIdentity | undefined;
  const captureSource = () => captureSourceIdentity(resolve(scenarioFile), {
    ...sourceSelection(scenarioFile, options.source, expectedEnvironment?.source), signal: captureController.signal,
    timeoutMs: SOURCE_IDENTITY_TIMEOUT_MS,
  });
  const unbound = (reason: string): void => {
    const hard = result.outcome === 'actor-error' || (result.outcome === 'harness-error' && result.reason !== undefined);
    result.outcome = hard ? 'harness-error' : 'inconclusive';
    result.reason = hard && result.reason ? `${result.reason}; ${reason}` : reason;
    delete result.failure;
  };
  try {
    if (!interruption && missingIdentity) {
      result.outcome = 'incompatible';
      result.reason = missingIdentity;
    } else if (!interruption && fixtureProfileMismatch) {
      result.outcome = 'incompatible';
      result.reason = 'Replay fixture profile differs from the recorded run';
    } else if (!interruption && protocolProfileMismatch) {
      result.outcome = 'incompatible';
      result.reason = 'Replay protocol profile differs from the recorded run';
    } else if (!interruption && expectedEnvironment?.transport && !transportMatches(expectedEnvironment.transport, result.environment.transport)) {
      result.outcome = 'incompatible';
      result.reason = 'Replay PostgreSQL transport differs from the recorded run; supply the same TLS policy, CA and hostname';
    } else if (!interruption && connectionProfileMismatch) {
      result.outcome = 'incompatible';
      result.reason = 'Replay actor connection profile differs from the recorded run';
    } else if (!interruption && overlapMismatch) {
      result.outcome = 'incompatible';
      result.reason = 'Replay overlap mode differs from the recorded run';
    } else if (!interruption && expectedEnvironment?.nodeVersion !== undefined && expectedEnvironment.nodeVersion !== process.version) {
      result.outcome = 'incompatible';
      result.reason = 'Replay Node.js version differs from the recorded environment';
    } else if (!interruption && expectedEnvironment && !expectedEnvironment.source) {
      result.outcome = 'incompatible';
      result.reason = 'The recorded run has no file source identity; use a guided run to create new bound evidence';
    } else if (!interruption) {
      sourceIdentity = await captureSource();
      if (!interruption) {
        const sourceBytes = Buffer.byteLength(JSON.stringify(sourceIdentity));
        if (Buffer.byteLength(JSON.stringify(result)) + sourceBytes + 512 > maxEvidenceBytes) {
          result.outcome = 'inconclusive'; result.reason = 'Source identity exceeds the execution evidence limit'; sourceIdentity = undefined;
        } else {
          result.environment.source = sourceIdentity;
          if (expectedEnvironment?.source && expectedEnvironment.source.fingerprint !== sourceIdentity.fingerprint) {
            result.outcome = 'incompatible'; result.reason = 'Replay source, installed dependencies or Interleave runtime identity changed';
          }
        }
      }
    }
    if (!interruption && sourceIdentity && result.outcome === 'harness-error') {
      // Never race creation against cancellation: the eventual handle owns the
      // exact generated database and must be retained for authoritative cleanup.
      armDeadline();
      database = await createOwnedDatabase(options.databaseUrl, transport);
      result.environment.serverVersion = database.serverVersion;
      if (expectedEnvironment && expectedEnvironment.serverVersion !== database.serverVersion) {
        result.outcome = 'incompatible';
        result.reason = 'Replay PostgreSQL version differs from the recorded environment';
      }
    }
    if (database && !interruption && result.outcome === 'harness-error') {
      const sourceMode = import.meta.url.endsWith('.ts');
      const worker = fileURLToPath(new URL(sourceMode ? './worker.ts' : './worker.js', import.meta.url));
      const protocolToken = randomUUID();
      const environment = { ...process.env };
      // Do not give scenario code an inherited administrator URL, libpq route or TLS
      // policy: actor connections are loopback plaintext and harness trust comes from IPC.
      for (const key of Object.keys(environment)) {
        if (/DATABASE.*URL|^PG(?:HOST|HOSTADDR|PORT|USER|PASSWORD|DATABASE|SERVICE|SERVICEFILE|PASSFILE|SSLMODE|SSLNEGOTIATION|SSLCERT|SSLCERTMODE|SSLKEY|SSLROOTCERT|SSLCRL|SSLCRLDIR|SSLSNI|SSLCOMPRESSION|REQUIRESSL|REQUIREAUTH|CHANNELBINDING|GSSENCMODE|TARGETSESSIONATTRS)$|^NODE_OPTIONS$|^NODE_PG_FORCE_NATIVE$/i.test(key)) delete environment[key];
      }
      child = fork(worker, [], {
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: sourceMode ? ['--import', import.meta.resolve('tsx')] : [], env: environment, serialization: 'json',
      });
      // Drain logs without retaining or forwarding arbitrary application output.
      // This bounds memory and prevents credentials/console writes becoming IPC.
      child.stdout?.resume();
      child.stderr?.resume();
      const workerChild = child;
      await new Promise<void>(resolveExit => {
        let grace: NodeJS.Timeout | undefined;
        let received: RunResult | undefined;
        let protocolFailure = false;
        let finished = false;
        stopChild = () => {
          if (grace) return;
          if (workerChild.connected) workerChild.send({ type: 'abort', token: protocolToken }, () => undefined);
          grace = setTimeout(() => terminateGroup(workerChild), GRACE_MS);
        };
        workerChild.on('message', (message: unknown) => {
          if (
            typeof message !== 'object' || message === null || !('type' in message)
            || !('token' in message) || message.token !== protocolToken
          ) { protocolFailure = true; terminateGroup(workerChild); return; }
          if (message.type === 'result' && 'run' in message && received === undefined) {
            try {
              const candidate = parseRunArtifact(message.run);
              if (
                candidate.environment.serverVersion !== database!.serverVersion
                || candidate.environment.nodeVersion !== process.version
                || !isDeepStrictEqual(candidate.environment.source, sourceIdentity)
                || !isDeepStrictEqual(candidate.environment.transport, result.environment.transport)
                || (candidate.limits.protocolProfile ?? 'sync-cycle-v1') !== protocolProfile
                || recordedConnectionProfile(candidate) !== connectionProfile
                || candidate.limits.overlap !== overlap
                || candidate.limits.maxConnectionsPerActor !== maxConnectionsPerActor
                || (candidate.environment.fixture !== undefined && recordedFixtureProfile(candidate.environment.fixture) !== fixtureProfile)
              ) throw new TypeError('Worker result changed parent-owned environment identity');
              received = {
                ...candidate,
                environment: {
                  ...candidate.environment,
                  serverVersion: database!.serverVersion,
                  nodeVersion: process.version,
                  source: sourceIdentity!,
                  transport: result.environment.transport!,
                },
              };
            }
            catch { protocolFailure = true; terminateGroup(workerChild); }
          } else if (message.type === 'running' && received === undefined) {
            // The worker's own deadline starts now and names what it was waiting
            // for; the parent backstop fires shortly after it.
            if (!interruption) armDeadline(timeoutMs + WORKER_DEADLINE_GRACE_MS);
          } else if (message.type === 'error') {
            result.reason = 'Scenario loading or worker execution failed';
          } else { protocolFailure = true; terminateGroup(workerChild); }
        });
        const done = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (finished) return;
          finished = true;
          if (grace) clearTimeout(grace);
          stopChild = undefined;
          if (protocolFailure) result.reason = 'Worker returned an invalid execution artifact';
          else if (received && code === 0 && signal === null) {
            Object.assign(result, received);
            receivedHardFailure = received.outcome === 'actor-error'
              || received.outcome === 'harness-error' || !received.cleanup.complete;
          }
          else {
            workerFailure = `Scenario worker exited before completing${signal ? ` (${signal})` : code === null ? '' : ` (exit ${code})`}`;
            result.reason ??= workerFailure;
          }
          resolveExit();
        };
        workerChild.once('exit', done);
        workerChild.once('error', () => { result.reason = 'Scenario worker could not be started'; terminateGroup(workerChild); done(null, null); });
        workerChild.send({
          type: 'start', token: protocolToken, scenarioFile: resolve(scenarioFile), connectionString: database!.connectionString,
          transport: database!.transport, sourceIdentity,
          options: { maxSteps, timeoutMs, maxEvidenceBytes, maxConnectionsPerActor, protocolProfile, connectionProfile, ...(overlap ? { overlap } : {}), fixtureProfile, mode, ...(options.plan ? { plan: options.plan } : {}), ...(options.replay ? { replay: options.replay } : {}), ...(options.expectedEnvironment ? { expectedEnvironment: options.expectedEnvironment } : {}) },
        }, error => { if (error) { result.reason = 'Could not initialize scenario worker'; terminateGroup(workerChild); } });
        if (interruption) stopChild();
      });
      clearTimeout(deadline);
      if (!interruption && sourceIdentity) {
        try {
          const after = await captureSource();
          if (after.fingerprint !== sourceIdentity.fingerprint) unbound('Source, installed dependencies or Interleave runtime changed during execution; the recorded inputs could not be verified');
        } catch (error) {
          unbound(error instanceof SourceIdentityError ? `Source identity could not be verified after execution: ${error.message}` : 'Source identity could not be verified after execution');
        }
      }
    }
  } catch (error) {
    if (error instanceof OwnedDatabaseCreationError) creationFailure = error;
    if (error instanceof SourceIdentityError) {
      result.outcome = error.kind === 'io' ? 'harness-error' : 'inconclusive';
      result.reason = error.message;
    } else result.reason = creationFailure?.message ?? connectionFailureMessage(error) ?? 'Could not prepare or supervise the scenario database and worker';
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
    // POSIX cleanup covers descendants still in this process group. Detached
    // processes remain the trusted scenario's responsibility; Windows kills only the worker.
    if (child) terminateGroup(child);
    if (interruption) {
      if (receivedHardFailure) {
        result.outcome = 'harness-error';
        result.reason = [...new Set([result.reason, interruption, workerFailure].filter(value => value !== undefined))].join('; ');
      } else {
        result.outcome = 'inconclusive';
        result.reason = workerFailure ? `${interruption}; ${workerFailure}` : interruption;
      }
      delete result.failure;
    }
    result.cleanup = { complete: false };
    if (creationFailure) {
      // No handle was returned; creation or its recovery left uncertain cleanup.
      result.cleanup.error = creationFailure.message;
      result.outcome = 'harness-error'; result.reason = creationFailure.message; delete result.failure;
    } else {
      try { await database?.close(); result.cleanup.complete = true; }
      catch {
        result.cleanup.error = `Parent could not completely clean up its owned database ${database!.name}`;
        result.outcome = 'harness-error'; delete result.failure;
      }
    }
    result.durationMs = performance.now() - started;
  }
  // Private evidence preserves the application's exact SQL and selected values.
  // It may contain sensitive data; sharing/export policy is a separate concern.
  return finalizeRunEvidence(result, maxEvidenceBytes);
}

function terminateGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) child.kill('SIGKILL');
  }
}
