import { runOnce } from './runner.js';
import { runScenarioFile } from './supervised.js';
import type { RunOptions, Scenario } from './types.js';

/** File targets retain process supervision across every search/replay attempt. */
export function runTarget(target: Scenario | string, options: RunOptions) {
  return typeof target === 'string' ? runScenarioFile(target, options) : runOnce(target, options);
}
