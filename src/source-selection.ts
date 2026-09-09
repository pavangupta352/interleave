import { resolve } from 'node:path';
import type { RunOptions } from './types.js';
import type { SourceIdentity } from './source-identity.js';

/** Relocate a recorded portable selection relative to the supplied entry file. */
export function sourceSelection(file: string, selected: RunOptions['source'], recorded?: SourceIdentity): RunOptions['source'] {
  if (!recorded) return selected;
  return {
    projectRoot: selected?.projectRoot ?? resolve(file, ...recorded.entry.split('/').map(() => '..')),
    include: selected?.include ?? recorded.includes,
  };
}
