import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { testDatabaseUrl } from './helpers/postgres.js';

const captures = vi.hoisted(() => ({ timeouts: [] as number[], delayMs: 0 }));
vi.mock('../src/source-identity.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/source-identity.js')>();
  return { ...actual, async captureSourceIdentity(...args: Parameters<typeof actual.captureSourceIdentity>) {
    captures.timeouts.push(args[1]?.timeoutMs ?? -1);
    // A slow capture, as on a loaded machine, must not consume execution time.
    await new Promise(resolve => setTimeout(resolve, captures.delayMs));
    return actual.captureSourceIdentity(...args);
  } };
});
import { runScenarioFile } from '../src/supervised.js';

const databaseUrl = testDatabaseUrl();
const fixture = fileURLToPath(new URL('./fixtures/supervised/slow-actors.ts', import.meta.url));

test('source identity capture has its own bound and never consumes the execution deadline', async () => {
  captures.delayMs = 5_000;
  // Actors run 3 s of the 8 s deadline. Capture before execution takes another 5 s.
  const run = await runScenarioFile(fixture, { databaseUrl, timeoutMs: 8_000 });
  expect(run.outcome, run.reason).toBe('passed');
  expect(run.environment.source).toBeDefined();
  expect(captures.timeouts).toEqual([60_000, 60_000]);
  expect(run.durationMs).toBeGreaterThan(8_000);
}, 90_000);
