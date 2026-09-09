import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import { minimize } from '../src/minimize.js';
import { explore } from '../src/explore.js';
import { runScenarioFile } from '../src/supervised.js';
import { parseCliArgs } from '../src/cli/options.js';
import { testDatabaseUrl } from './helpers/postgres.js';
import type { RunOptions, Scenario } from '../src/types.js';

describe('protocol profile propagation', () => {
  const databaseUrl = testDatabaseUrl();
  const scenario: Scenario = {
    name: 'ordinary queries in staged profile', async setup() {},
    actors: {
      async reader({ connectionString }) {
        const client = new Client({ connectionString }); await client.connect();
        try { return (await client.query('SELECT $1::integer AS value', [3])).rows[0]; }
        finally { await client.end(); }
      },
      async idle() {},
    }, async invariant() {},
  };

  test.each([null, '', 'automatic', 2])('rejects invalid profile %s before database work or scenario import', async value => {
    const options = { databaseUrl: 'invalid-url', protocolProfile: value } as unknown as RunOptions;
    await expect(runOnce(scenario, options)).rejects.toThrow(/protocolProfile/);
    await expect(runScenarioFile('/missing-profile-fixture.mjs', options)).rejects.toThrow(/protocolProfile/);
    const fixtureOptions = { databaseUrl: 'invalid-url', fixtureProfile: value } as unknown as RunOptions;
    await expect(runOnce(scenario, fixtureOptions)).rejects.toThrow(/fixtureProfile/);
    await expect(runScenarioFile('/missing-profile-fixture.mjs', fixtureOptions)).rejects.toThrow(/fixtureProfile/);
  });

  test('records ordinary queries explicitly in v2 and inherits the profile for exact and guided replay', async () => {
    const options: RunOptions = { databaseUrl: databaseUrl, protocolProfile: 'describe-flush-v1' };
    const recorded = await runOnce(scenario, options);
    expect(recorded.outcome, recorded.reason).toBe('passed');
    expect(recorded.schemaVersion).toBe(2);
    expect(recorded.trace[0]).toMatchObject({ stage: 'complete', cycle: 0, completion: { kind: 'ready' } });
    for (const mode of ['replay', 'guided'] as const) {
      const repeated = await replay(scenario, recorded, { databaseUrl: databaseUrl, mode });
      expect(repeated.outcome, repeated.reason).toBe('passed');
      expect(repeated.schemaVersion).toBe(2);
      expect(repeated.limits.protocolProfile).toBe('describe-flush-v1');
      expect(repeated.cleanup.complete).toBe(true);
    }
    const changed = await replay(scenario, recorded, { databaseUrl: databaseUrl, protocolProfile: 'sync-cycle-v1' });
    expect(changed.outcome).toBe('incompatible');
    expect(changed.reason).toMatch(/protocol profile/);
    expect(changed.trace).toHaveLength(0);
  });

  test('binds the selected protocol in supervised execution and rejects a change before loading the scenario', async () => {
    const file = fileURLToPath(new URL('./fixtures/supervised/counter.ts', import.meta.url));
    const recorded = await runScenarioFile(file, { databaseUrl: databaseUrl, protocolProfile: 'describe-flush-v1' });
    expect(recorded.outcome, recorded.reason).toBe('violation');
    expect(recorded.schemaVersion).toBe(2);
    expect(recorded.trace.every(step => step.stage === 'complete' && step.completion?.kind === 'ready')).toBe(true);
    const repeated = await replay(file, recorded, { databaseUrl: databaseUrl });
    expect(repeated.outcome, repeated.reason).toBe('violation');
    const incompatible = await replay('/missing-profile-fixture.mjs', recorded, {
      databaseUrl: 'invalid-url', protocolProfile: 'sync-cycle-v1',
    });
    expect(incompatible.outcome).toBe('incompatible');
    expect(incompatible.reason).toMatch(/protocol profile/);
    expect(incompatible.environment.serverVersion).toBe('unknown');
    expect(incompatible.cleanup.complete).toBe(true);
    const changedFixture = await replay('/missing-profile-fixture.mjs', recorded, {
      databaseUrl: 'invalid-url', fixtureProfile: 'postgresql17-pgvector0.8.6-v1',
    });
    expect(changedFixture.outcome).toBe('incompatible');
    expect(changedFixture.reason).toMatch(/fixture profile/);
    expect(changedFixture.environment.serverVersion).toBe('unknown');
    expect(changedFixture.cleanup.complete).toBe(true);
    const reduced = await minimize(file, recorded, { databaseUrl, maxAttempts: 3 });
    expect(reduced.run.schemaVersion).toBe(2);
    expect(reduced.run.limits.protocolProfile).toBe('describe-flush-v1');
    expect(reduced.run.failure?.fingerprint).toBe(recorded.failure?.fingerprint);
    expect(reduced.run.cleanup.complete).toBe(true);
    expect(reduced.attempts).toBe(3);
  });

  test('propagates the selected profile through every exploration execution', async () => {
    const result = await explore(scenario, { databaseUrl, protocolProfile: 'describe-flush-v1', maxRuns: 2 });
    expect(result.explored).toBeGreaterThan(0);
    expect(result.runs.every(run => run.schemaVersion === 2 && run.limits.protocolProfile === 'describe-flush-v1' && run.cleanup.complete)).toBe(true);
  });

  test('accepts only explicit CLI profiles and only on commands that execute a scenario', () => {
    for (const value of ['sync-cycle-v1', 'describe-flush-v1']) {
      expect(parseCliArgs(['run', 'scenario.mjs', '--protocol-profile', value]).values['protocol-profile']).toBe(value);
    }
    expect(() => parseCliArgs(['run', 'scenario.mjs', '--protocol-profile', 'automatic'])).toThrow(/protocol-profile/);
    expect(() => parseCliArgs(['report', 'run.json', '--protocol-profile', 'describe-flush-v1'])).toThrow(/not supported/);
    for (const value of ['native', 'postgresql17-pgvector0.8.6-v1']) {
      expect(parseCliArgs(['run', 'scenario.mjs', '--fixture-profile', value]).values['fixture-profile']).toBe(value);
    }
    expect(() => parseCliArgs(['run', 'scenario.mjs', '--fixture-profile', 'automatic'])).toThrow(/fixture-profile/);
    expect(() => parseCliArgs(['report', 'run.json', '--fixture-profile', 'native'])).toThrow(/not supported/);
  });
});
