/** A shared execution deadline; owned database cleanup is still awaited afterward. */
export function searchBudget(totalTimeoutMs: number | undefined, external?: AbortSignal) {
  const timeoutMs = integerLimit(totalTimeoutMs, 60_000, 3_600_000, 'totalTimeoutMs');
  const controller = new AbortController();
  const started = performance.now();
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    reason(): 'aborted' | 'deadline' | undefined {
      if (external?.aborted) return 'aborted';
      if (controller.signal.aborted || performance.now() - started >= timeoutMs) {
        controller.abort();
        return 'deadline';
      }
      return undefined;
    },
    close() { clearTimeout(timer); external?.removeEventListener('abort', abort); },
  };
}

export function integerLimit(value: number | undefined, fallback: number, max: number, name: string, min = 1): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  return result;
}
