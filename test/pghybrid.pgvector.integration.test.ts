import { describe, expect, test } from 'vitest';
import { runOnce } from '../src/runner.js';
import { createPghybridScenario, PGHYBRID_PLAN } from '../examples/pghybrid/scenario.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const adminUrl = testDatabaseUrl();

function traceIdentity(run: Awaited<ReturnType<typeof runOnce>>) {
  return run.trace.map(({ actor, connection, ordinal, protocol, sql, fingerprint }) => ({
    actor, connection, ordinal, protocol, sql, fingerprint,
  }));
}

describe('pghybrid 0.1.4 forPg compatibility workload', () => {
  test('records and exactly replays the unchanged packed forPg API', async () => {
    const recorded = await runOnce(createPghybridScenario(), {
      databaseUrl: adminUrl,
      fixtureProfile: 'postgresql17-pgvector0.8.6-v1',
      plan: [...PGHYBRID_PLAN],
      timeoutMs: 30_000,
    });

    expect(recorded.outcome, recorded.reason).toBe('passed');
    expect(recorded.environment.fixture?.profile).toBe('postgresql17-pgvector0.8.6-v1');
    expect(recorded.environment.fixture?.counts.rows).toBe(12);
    expect(recorded.trace.map(step => step.actor)).toEqual(PGHYBRID_PLAN);
    expect(recorded.actors.map(result => result.value)).toEqual([
      ['Termination for convenience', 'Renewal pricing', 'Renewal terms'],
      ['Termination for convenience', 'Renewal pricing', 'Renewal terms'],
    ]);
    expect(recorded.trace).toHaveLength(2);
    expect(recorded.trace.every(step => step.sql.includes('websearch_to_tsquery'))).toBe(true);
    expect(recorded.trace.every(step => step.sql.includes('<=>'))).toBe(true);
    expect(recorded.cleanup.complete).toBe(true);
    const replayed = await runOnce(createPghybridScenario(), {
      databaseUrl: adminUrl,
      fixtureProfile: 'postgresql17-pgvector0.8.6-v1',
      replay: recorded,
      timeoutMs: 30_000,
    });
    expect(replayed.outcome, replayed.reason).toBe('passed');
    expect(traceIdentity(replayed)).toEqual(traceIdentity(recorded));
    expect(replayed.actors).toEqual(recorded.actors);
    expect(replayed.environment.fixture?.fingerprint).toBe(recorded.environment.fixture?.fingerprint);
    expect(replayed.cleanup.complete).toBe(true);
  });
});
