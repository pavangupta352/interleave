import assert from 'node:assert/strict';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import { minimize } from '../src/minimize.js';
import { parseRunArtifact } from '../src/artifact.js';
import { parseCliArgs } from '../src/cli/options.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';
const databaseUrl = testDatabaseUrl();
const scenario: Scenario = {
  name: 'auxiliary-session-runner', async setup() {},
  actors: Object.fromEntries(['alice', 'bob'].map(name => [name, async ({ connectionString }: { connectionString: string }) => {
    const monitor = new Client({ connectionString }); const query = new Client({ connectionString });
    monitor.on('error', () => {}); query.on('error', () => {});
    try { await monitor.connect(); await query.connect(); return (await query.query('SELECT 1 AS n')).rows[0].n; }
    finally { await Promise.all([query.end(), monitor.end()]); }
  }])),
  async invariant() { assert.fail('the same deliberate test invariant'); },
};

test('an explicit auxiliary connection profile records all startups and replays/reduces without repeating the option', async () => {
  const first = await runOnce(scenario, { databaseUrl, maxConnectionsPerActor: 2 });
  expect(first.outcome, first.reason).toBe('violation');
  expect(first.limits.maxConnectionsPerActor).toBe(2);
  expect(first.connections).toHaveLength(4);
  for (const value of [0, 9, 1.5, null]) {
    const malformed = structuredClone(first) as unknown as { limits: { maxConnectionsPerActor: unknown } };
    malformed.limits.maxConnectionsPerActor = value;
    expect(() => parseRunArtifact(malformed)).toThrow(/maxConnectionsPerActor/);
  }
  expect(first.trace.map(step => step.connection)).toEqual([1, 1]);
  const second = await replay(scenario, parseRunArtifact(JSON.stringify(first)), { databaseUrl });
  expect(second.outcome, second.reason).toBe('violation');
  const reduced = await minimize(scenario, first, { databaseUrl, maxAttempts: 5 });
  expect(reduced.locallyMinimal).toBe(true);
  expect(reduced.run.limits.maxConnectionsPerActor).toBe(2);
});

test('changing the exact connection profile rejects before actor commands', async () => {
  const first = await runOnce(scenario, { databaseUrl, maxConnectionsPerActor: 2 });
  expect(first.outcome, first.reason).toBe('violation');
  const second = await replay(scenario, first, { databaseUrl, maxConnectionsPerActor: 1 });
  expect(second.outcome).toBe('incompatible'); expect(second.reason).toMatch(/connection.*profile/i);
  expect(second.trace).toEqual([]); expect(second.cleanup.complete).toBe(true);
});

test('connection profile limits are validated by the CLI, API and artifact reader', async () => {
  expect(parseCliArgs(['run', 'scenario.mjs', '--max-connections-per-actor', '2']).values['max-connections-per-actor']).toBe('2');
  for (const value of [0, 9, 1.5, null]) {
    expect(() => parseCliArgs(['run', 'scenario.mjs', '--max-connections-per-actor', String(value)])).toThrow(/integer/);
    await expect(runOnce(scenario, { databaseUrl, maxConnectionsPerActor: value as number })).rejects.toThrow(/maxConnectionsPerActor/);
  }
});

test('closing an auxiliary retains the live command backend as an owned lock blocker', async () => {
  const locking: Scenario = {
    name: 'auxiliary-close-lock-owner',
    async setup({ db }) { await db.query('CREATE TABLE counter(n int); INSERT INTO counter VALUES (0)'); },
    actors: Object.fromEntries(['alice', 'bob'].map(name => [name, async ({ connectionString }: { connectionString: string }) => {
      const monitor = new Client({ connectionString }); const query = new Client({ connectionString });
      monitor.on('error', () => {}); query.on('error', () => {});
      try {
        await monitor.connect(); await query.connect();
        await query.query('BEGIN'); await query.query('UPDATE counter SET n = n + 1');
        if (name === 'alice') { await monitor.end(); await query.query('SELECT 1'); }
        await query.query('COMMIT');
      } finally { await Promise.all([query.end(), monitor.end()]); }
    }])),
    async invariant({ db }) { assert.equal((await db.query('SELECT n FROM counter')).rows[0].n, 2); },
  };
  const result = await runOnce(locking, { databaseUrl, maxConnectionsPerActor: 2,
    plan: ['alice', 'bob', 'alice', 'bob', 'alice', 'alice', 'bob'] });
  expect(result.outcome, result.reason).toBe('passed');
  expect(result.trace.find(step => step.actor === 'bob' && step.sql.startsWith('UPDATE'))?.waits.length).toBeGreaterThan(0);
  expect(result.cleanup.complete).toBe(true);
});
