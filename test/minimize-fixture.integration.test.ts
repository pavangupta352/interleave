import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { minimize } from '../src/minimize.js';
import { runOnce } from '../src/runner.js';
import { runScenarioFile } from '../src/supervised.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();

test.each([3, 4])('reduction rejects fixture drift on setup %i before candidate actors and retains its last compatible failure', async driftAt => {
  let setups = 0;
  let actors = 0;
  const databases: string[] = [];
  const actor: Scenario['actors'][string] = async ({ connectionString }) => {
    actors++;
    const client = new Client({ connectionString }); await client.connect();
    try { return (await client.query('SELECT value FROM counter')).rows; }
    finally { await client.end(); }
  };
  const scenario: Scenario = {
    name: 'reduction-fixture-drift',
    async setup({ db, connectionString }) {
      databases.push(new URL(connectionString).pathname.slice(1));
      setups++;
      await db.query('CREATE TABLE counter(value integer); INSERT INTO counter VALUES(1)');
      if (setups >= driftAt) await db.query('UPDATE counter SET value=2');
    },
    actors: { alice: actor, bob: actor },
    async invariant() { assert.fail('same stable application assertion'); },
  };
  const original = await runOnce(scenario, { databaseUrl });
  expect(original.outcome).toBe('violation');
  const result = await minimize(scenario, original, { databaseUrl, maxAttempts: 8 });
  expect(result.stopReason).toBe('inconclusive');
  expect(result.locallyMinimal).toBe(false);
  expect(result.reason).toMatch(/fixture/i);
  expect(result.attempts).toBe(driftAt - 1);
  expect(result.reducedChoices).toBe(driftAt === 3 ? 2 : 1);
  expect(actors).toBe((driftAt - 1) * 2);
  expect(result.run.environment).toEqual(original.environment);
  expect(result.run.failure?.fingerprint).toBe(original.failure?.fingerprint);
  expect(parseRunArtifact(JSON.stringify(result.run)).cleanup.complete).toBe(true);
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  try { expect((await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [databases])).rows).toEqual([]); }
  finally { await admin.end(); }
});

test('environment binding lets reduction retain SQL changes caused by a different schedule', async () => {
  const scenario: Scenario = {
    name: 'reduction-schedule-dependent-sql',
    async setup({ db }) { await db.query('CREATE TABLE counter(value integer); INSERT INTO counter VALUES(0)'); },
    actors: {
      async alice({ connectionString }) {
        const client = new Client({ connectionString }); await client.connect();
        try { await client.query('UPDATE counter SET value=1'); await client.query('SELECT value FROM counter'); }
        finally { await client.end(); }
      },
      async bob({ connectionString }) {
        const client = new Client({ connectionString }); await client.connect();
        try { const value = (await client.query('SELECT value FROM counter')).rows[0].value; await client.query(`SELECT ${value}`); }
        finally { await client.end(); }
      },
    },
    async invariant() { assert.fail('same failure across valid schedules'); },
  };
  const original = await runOnce(scenario, { databaseUrl, plan: ['bob', 'alice', 'bob', 'alice'] });
  expect(original.outcome).toBe('violation');
  expect(original.trace.some(step => step.sql === 'SELECT 0')).toBe(true);
  const result = await minimize(scenario, original, { databaseUrl, maxAttempts: 8 });
  expect(result.locallyMinimal).toBe(true);
  expect(result.reducedChoices).toBe(0);
  expect(result.run.trace.some(step => step.sql === 'SELECT 1')).toBe(true);
  expect(result.run.environment).toEqual(original.environment);
  expect(result.run.failure?.fingerprint).toBe(original.failure?.fingerprint);
});

test.each(['serverVersion', 'nodeVersion', 'fixture'] as const)('an explicit %s binding fails before setup and actor side effects', async field => {
  let setups = 0, actors = 0;
  const scenario: Scenario = {
    name: 'expected-environment-before-setup',
    async setup({ db }) { setups++; await db.query('CREATE TABLE counter(value integer)'); },
    actors: { alice: async () => { actors++; }, bob: async () => { actors++; } },
    async invariant() {},
  };
  const original = await runOnce(scenario, { databaseUrl });
  expect(original.outcome).toBe('passed');
  const expectedEnvironment = structuredClone(original.environment);
  if (field === 'fixture') delete expectedEnvironment.fixture;
  else expectedEnvironment[field] = 'different recorded runtime';
  const run = await runOnce(scenario, { databaseUrl, expectedEnvironment });
  expect(run.outcome).toBe('incompatible');
  expect(setups).toBe(1); expect(actors).toBe(2);
  expect(run.trace).toEqual([]); expect(run.cleanup.complete).toBe(true);
});

test('supervised reduction forwards environment binding and never invokes actors for a changed fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interleave-minimize-state-'));
  const key = 'INTERLEAVE_MINIMIZE_PROBE_DIRECTORY';
  const previous = process.env[key]; process.env[key] = directory;
  try {
    const target = fileURLToPath(new URL('./fixtures/supervised/minimize-fixture-drift.ts', import.meta.url));
    const original = await runScenarioFile(target, { databaseUrl });
    expect(original.outcome).toBe('violation');
    const reduced = await minimize(target, original, { databaseUrl, maxAttempts: 5 });
    expect(reduced.stopReason).toBe('inconclusive');
    expect(reduced.reason).toMatch(/fixture/i);
    expect(reduced.locallyMinimal).toBe(false);
    expect(reduced.attempts).toBe(2);
    expect(reduced.reducedChoices).toBe(2);
    expect(reduced.run.environment).toEqual(original.environment);
    expect((await readFile(join(directory, 'actors'), 'utf8')).trim().split('\n')).toHaveLength(4);
    const databases = (await readFile(join(directory, 'databases'), 'utf8')).trim().split('\n');
    expect(databases).toHaveLength(3);
    const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
    try { expect((await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [databases])).rows).toEqual([]); }
    finally { await admin.end(); }
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
