import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { testDatabaseUrl } from './helpers/postgres.js';

const capture = vi.hoisted(() => ({ calls: 0, secondStarted: false }));
vi.mock('../src/source-identity.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/source-identity.js')>();
  return {
    ...actual,
    async captureSourceIdentity(...args: Parameters<typeof actual.captureSourceIdentity>) {
      capture.calls += 1;
      if (capture.calls === 1) return actual.captureSourceIdentity(...args);
      capture.secondStarted = true;
      const signal = args[1]?.signal;
      await new Promise<never>((_resolve, reject) => {
        const aborted = () => reject(new actual.SourceIdentityError('aborted', 'controlled post-run capture abort'));
        if (signal?.aborted) aborted();
        else signal?.addEventListener('abort', aborted, { once: true });
      });
    },
  };
});
import { runScenarioFile } from '../src/supervised.js';

test('post-run capture cancellation preserves an actor error as a hard failure', async () => {
  const controller = new AbortController();
  const scenario = fileURLToPath(new URL('./fixtures/supervised/query-error.ts', import.meta.url));
  const running = runScenarioFile(scenario, { databaseUrl: testDatabaseUrl(), signal: controller.signal });
  const deadline = Date.now() + 10_000;
  while (!capture.secondStarted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(capture.secondStarted).toBe(true);
  controller.abort();
  const result = await running;
  expect(result.outcome).toBe('harness-error');
  expect(result.reason).toMatch(/application operations rejected/i);
  expect(result.reason).toMatch(/cancel|source|capture/i);
  expect(result.actors.every(actor => actor.status === 'rejected')).toBe(true);
  expect(result.cleanup.complete).toBe(true);
});

test('a null connection limit is rejected instead of becoming the default profile', async () => {
  const scenario = fileURLToPath(new URL('./fixtures/supervised/query-error.ts', import.meta.url));
  await expect(runScenarioFile(scenario, {
    databaseUrl: testDatabaseUrl(), maxConnectionsPerActor: null as never,
  })).rejects.toThrow(/maxConnectionsPerActor.*integer.*1.*8/i);
});
