import type { ProtocolProfile } from './types.js';

/** Resolve only an omitted option; null and unknown strings are invalid input. */
export function resolveProtocolProfile(value: unknown, fallback: ProtocolProfile = 'sync-cycle-v1'): ProtocolProfile {
  const selected = value === undefined ? fallback : value;
  if (selected !== 'sync-cycle-v1' && selected !== 'describe-flush-v1' && selected !== 'flush-stages-v1') {
    throw new TypeError('protocolProfile must be sync-cycle-v1, describe-flush-v1 or flush-stages-v1');
  }
  return selected;
}
