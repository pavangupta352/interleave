import { createHash } from 'node:crypto';
import type { ExplorationSearch } from './types.js';

/** Shared API/CLI validation; never chooses an ambient seed. */
export function normalizeExplorationSearch(options: { strategy?: unknown; seed?: unknown }): ExplorationSearch {
  const { strategy, seed } = options;
  if (strategy !== undefined && strategy !== 'fifo' && strategy !== 'seeded') {
    throw new TypeError('Exploration strategy must be fifo or seeded');
  }
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isSafeInteger(seed) || Object.is(seed, -0) || seed < 0 || seed > 0xffff_ffff)) {
    throw new TypeError('Exploration seed must be a uint32 integer (0 through 4294967295), excluding negative zero');
  }
  if (strategy === 'fifo' && seed !== undefined) throw new TypeError('FIFO exploration cannot specify a seed');
  if (strategy === 'seeded' && seed === undefined) throw new TypeError('Seeded exploration requires a seed');
  return seed === undefined ? { version: 1, strategy: 'fifo' } : { version: 1, strategy: 'seeded', seed: seed as number };
}

/** One hash per dispatched attempt; preserve all remaining frontier entry order. */
export function frontierIndex(search: ExplorationSearch, dequeue: number, length: number): number {
  if (search.strategy === 'fifo') return 0;
  const hash = createHash('sha256').update(`interleave:seeded-frontier-v1\0${search.seed}\0${dequeue}`).digest();
  return hash.readUInt32BE(0) % length;
}
