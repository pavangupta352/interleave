import { replay } from './replay.js';
import { runTarget } from './run-target.js';
import { integerLimit, searchBudget } from './search-budget.js';
import { environmentMatches } from './environment.js';
import type { Scenario, RunResult, MinimizeOptions, MinimizationResult } from './types.js';

type AttemptFailure = NonNullable<MinimizationResult['attemptFailure']>;
function summarizeHardFailure(run: RunResult): AttemptFailure | undefined {
  if (run.outcome !== 'actor-error' && run.outcome !== 'harness-error' && run.cleanup.complete) return undefined;
  return {
    outcome: run.outcome === 'actor-error' && run.cleanup.complete ? 'actor-error' : 'harness-error',
    ...(run.reason === undefined ? {} : { reason: run.reason.length > 4096 ? `${run.reason.slice(0,4096)}… [message truncated]` : run.reason }),
    // Cleanup diagnostics contain the exact owned database identity required for
    // recovery. Preserve them independently of the bounded display reason.
    cleanup: { ...run.cleanup },
  };
}

export class MinimizationVerificationError extends Error {
  constructor(readonly outcome: RunResult['outcome'], interruption?: 'aborted' | 'deadline', readonly attemptFailure?: AttemptFailure) {
    const diagnostic = attemptFailure && !attemptFailure.cleanup.complete
      ? ` Cleanup incomplete: ${attemptFailure.cleanup.error ?? 'Owned cleanup could not be confirmed'}`
      : attemptFailure?.reason ? ` ${attemptFailure.reason}` : '';
    super(`The original failure did not reproduce in a compatible replay (${outcome}${interruption ? `; ${interruption}` : ''}).${diagnostic}`);
    this.name = 'MinimizationVerificationError';
  }
}

/** Reduce explicit choices under the runner's fair fallback, never application SQL. */
export async function minimize(scenario: Scenario | string, original: RunResult, options: MinimizeOptions): Promise<MinimizationResult> {
  if (original.outcome !== 'violation' || !original.failure) throw new TypeError('Minimization requires an observed invariant failure');
  const maxAttempts = integerLimit(options.maxAttempts, 100, 10_000, 'maxAttempts');
  const { replay: _ignoredReplay, mode: _ignoredMode, plan: _ignoredPlan, expectedEnvironment: _ignoredEnvironment, ...selected } = options;
  const base = { ...selected, maxConnectionsPerActor: options.maxConnectionsPerActor === undefined ? original.limits.maxConnectionsPerActor ?? 1 : options.maxConnectionsPerActor };
  const budget = searchBudget(options.totalTimeoutMs, options.signal);
  try {
    const verified = await replay(scenario, original, { ...base, signal: budget.signal, mode: 'replay' });
    const verificationFailure = summarizeHardFailure(verified);
    if (verificationFailure || verified.outcome !== 'violation' || verified.failure?.fingerprint !== original.failure.fingerprint) {
      throw new MinimizationVerificationError(verificationFailure?.outcome ?? verified.outcome, budget.reason(), verificationFailure);
    }
    let plan = original.trace.map(step => step.actor);
    const originalChoices = plan.length;
    let run = verified;
    const expectedEnvironment = structuredClone(verified.environment);
    let attemptFailure: AttemptFailure | undefined;
    let reason: string | undefined;
    let attempts = 1;
    let chunks = 2;
    let locallyMinimal = plan.length === 0;
    let stopReason: MinimizationResult['stopReason'] = locallyMinimal ? 'locally-minimal' : 'max-attempts';
    reduction: while (plan.length && attempts < maxAttempts) {
      const interruption = budget.reason();
      if (interruption) { stopReason = interruption; break; }
      const size = Math.ceil(plan.length / chunks);
      let reduced = false;
      for (let start = 0; start < plan.length; start += size) {
        const stopped = budget.reason();
        if (stopped) { stopReason = stopped; break reduction; }
        if (attempts >= maxAttempts) break reduction;
        const candidate = [...plan.slice(0, start), ...plan.slice(start + size)];
        const trial = await runTarget(scenario, { ...base, signal: budget.signal, plan: candidate, mode: 'explore', expectedEnvironment });
        attempts++;
        // A shared deadline must not erase a cleanup or application failure
        // already observed by the completed attempt.
        attemptFailure = summarizeHardFailure(trial);
        if (attemptFailure) { stopReason = 'inconclusive'; break reduction; }
        const interrupted = budget.reason();
        if (interrupted) { stopReason = interrupted; break reduction; }
        if (!environmentMatches(expectedEnvironment, trial.environment)) {
          stopReason = 'inconclusive';
          reason = trial.reason ?? 'Reduction candidate environment differs from the verified starting conditions';
          break reduction;
        }
        if (trial.outcome === 'violation' && trial.failure?.fingerprint === original.failure.fingerprint) {
          plan = candidate; run = trial; chunks = Math.max(2, chunks - 1); reduced = true;
          break;
        }
        if (trial.outcome === 'inconclusive') { stopReason = 'inconclusive'; break reduction; }
      }
      if (reduced) {
        locallyMinimal = plan.length === 0;
        if (locallyMinimal) stopReason = 'locally-minimal';
        continue;
      }
      if (chunks >= plan.length) { locallyMinimal = true; stopReason = 'locally-minimal'; break; }
      chunks = Math.min(plan.length, chunks * 2);
    }
    return { originalChoices, reducedChoices: plan.length, attempts, locallyMinimal, plan, run, stopReason, ...(reason ? { reason } : {}), ...(attemptFailure ? { attemptFailure } : {}) };
  } finally { budget.close(); }
}
