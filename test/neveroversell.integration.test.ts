import { testDatabaseUrl } from './helpers/postgres.js';
import { describe, expect, test } from 'vitest';
import { runOnce } from '../src/runner.js';
import {
  createNaiveOversellScenario,
  createSafeReservationScenario,
  NAIVE_OVERSELL_PLAN,
} from '../examples/neveroversell/scenario.js';

const databaseUrl =
  testDatabaseUrl();

function traceIdentity(run: Awaited<ReturnType<typeof runOnce>>) {
  return run.trace.map(({ actor, connection, ordinal, protocol, sql, fingerprint }) => ({
    actor,
    connection,
    ordinal,
    protocol,
    sql,
    fingerprint,
  }));
}

describe('neveroversell integration', () => {
  test('forces the unchanged naiveBuy gapMs=0 demo to oversell and replays its exact trace', async () => {
    const recorded = await runOnce(createNaiveOversellScenario(), {
      databaseUrl,
      plan: [...NAIVE_OVERSELL_PLAN],
      timeoutMs: 20_000,
    });

    expect(recorded.outcome).toBe('violation');
    expect(recorded.trace.map((step) => step.actor)).toEqual(NAIVE_OVERSELL_PLAN);
    expect(recorded.actors.map(({ status, value }) => ({ status, value }))).toEqual([
      { status: 'fulfilled', value: 'sold' },
      { status: 'fulfilled', value: 'sold' },
    ]);
    expect(recorded.failure?.message).toContain('constructed naiveBuy demo oversold');
    expect(recorded.cleanup.complete).toBe(true);

    const expectedTrace = traceIdentity(recorded);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replayed = await runOnce(createNaiveOversellScenario(), {
        databaseUrl,
        mode: 'replay',
        replay: recorded,
        timeoutMs: 20_000,
      });

      expect(replayed.outcome).toBe('violation');
      expect(replayed.failure?.fingerprint).toBe(recorded.failure?.fingerprint);
      expect(traceIdentity(replayed)).toEqual(expectedTrace);
      expect(replayed.cleanup.complete).toBe(true);
    }
  });

  test('runs production safe reservations as opaque server-function calls', async () => {
    const run = await runOnce(createSafeReservationScenario(), {
      databaseUrl,
      plan: ['alice', 'bob'],
      timeoutMs: 20_000,
    });

    expect(run.outcome).toBe('passed');
    expect(run.actors.map(({ status, value }) => ({ status, value }))).toEqual([
      { status: 'fulfilled', value: 'held' },
      { status: 'fulfilled', value: 'insufficient' },
    ]);
    expect(run.trace).toHaveLength(2);
    expect(run.trace.every((step) => /^select \* from nos_hold\(/i.test(step.sql))).toBe(true);
    expect(run.cleanup.complete).toBe(true);
  });
});
