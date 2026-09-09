import { fork, type ChildProcess } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedDatabase, OwnedDatabaseCreationError } from './database.js';
import { parseRunArtifact } from './artifact.js';
import { assertEvidenceEnvelope, finalizeRunEvidence } from './evidence.js';
import type { OwnedDatabase, RunOptions, RunResult } from './types.js';

const GRACE_MS = 250;

function limit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
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
  if (options.replay) parseRunArtifact(options.replay);
  if (options.plan && (!Array.isArray(options.plan) || options.plan.length > 100_000 || options.plan.some(actor => typeof actor !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(actor) || ['constructor', 'prototype', '__proto__'].includes(actor)))) throw new TypeError('plan contains an invalid actor');
  const started = performance.now();
  const result: RunResult = {
    schemaVersion: 1, scenario: basename(scenarioFile).slice(0, 256), outcome: 'harness-error', mode,
    plan: [...(options.plan ?? [])], trace: [], actors: [],
    environment: { serverVersion: 'unknown', nodeVersion: process.version },
    startedAt: new Date().toISOString(), durationMs: 0,
    limits: { maxSteps, timeoutMs, maxEvidenceBytes }, cleanup: { complete: false },
  };
  assertEvidenceEnvelope(result, maxEvidenceBytes);
  let database: OwnedDatabase | undefined;
  let creationFailure: OwnedDatabaseCreationError | undefined;
  let child: ChildProcess | undefined;
  let interruption: string | undefined;
  let workerFailure: string | undefined;
  let stopChild: (() => void) | undefined;
  const interrupt = (reason: string): void => { interruption ??= reason; stopChild?.(); };
  const onAbort = (): void => interrupt('Execution was cancelled');
  const deadline = setTimeout(() => interrupt(`Execution exceeded its ${timeoutMs} ms deadline`), timeoutMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    if (!interruption) {
      // Never race creation against cancellation: the eventual handle owns the
      // exact generated database and must be retained for authoritative cleanup.
      database = await createOwnedDatabase(options.databaseUrl);
      result.environment.serverVersion = database.serverVersion;
    }
    if (database && !interruption) {
      const sourceMode = import.meta.url.endsWith('.ts');
      const worker = fileURLToPath(new URL(sourceMode ? './worker.ts' : './worker.js', import.meta.url));
      const environment = { ...process.env };
      // Do not give scenario code an inherited administrator URL or libpq route.
      for (const key of Object.keys(environment)) {
        if (/DATABASE.*URL|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|PASSFILE|SSLCERT|SSLKEY)$|^NODE_OPTIONS$/i.test(key)) delete environment[key];
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
          if (workerChild.connected) workerChild.send({ type: 'abort' }, () => undefined);
          grace = setTimeout(() => terminateGroup(workerChild), GRACE_MS);
        };
        workerChild.on('message', (message: unknown) => {
          if (typeof message !== 'object' || message === null || !('type' in message)) { protocolFailure = true; terminateGroup(workerChild); return; }
          if (message.type === 'result' && 'run' in message && received === undefined) {
            try { received = parseRunArtifact(message.run); }
            catch { protocolFailure = true; terminateGroup(workerChild); }
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
          else if (received && code === 0 && signal === null) Object.assign(result, received);
          else {
            workerFailure = `Scenario worker exited before completing${signal ? ` (${signal})` : code === null ? '' : ` (exit ${code})`}`;
            result.reason ??= workerFailure;
          }
          resolveExit();
        };
        workerChild.once('exit', done);
        workerChild.once('error', () => { result.reason = 'Scenario worker could not be started'; terminateGroup(workerChild); done(null, null); });
        workerChild.send({
          type: 'start', scenarioFile: resolve(scenarioFile), connectionString: database!.connectionString,
          options: { maxSteps, timeoutMs, maxEvidenceBytes, mode, ...(options.plan ? { plan: options.plan } : {}), ...(options.replay ? { replay: options.replay } : {}), ...(options.expectedEnvironment ? { expectedEnvironment: options.expectedEnvironment } : {}) },
        }, error => { if (error) { result.reason = 'Could not initialize scenario worker'; terminateGroup(workerChild); } });
        if (interruption) stopChild();
      });
    }
  } catch (error) {
    if (error instanceof OwnedDatabaseCreationError) creationFailure = error;
    result.reason = creationFailure?.message ?? 'Could not prepare or supervise the scenario database and worker';
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
    // POSIX cleanup covers descendants still in this process group. Detached
    // processes remain the trusted scenario's responsibility; Windows kills only the worker.
    if (child) terminateGroup(child);
    if (interruption) {
      result.outcome = 'inconclusive'; result.reason = workerFailure ? `${interruption}; ${workerFailure}` : interruption; delete result.failure;
    }
    result.cleanup = { complete: false };
    if (creationFailure) {
      // No handle was returned, but the failed creation still owns a database.
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
