import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import { parseRunArtifact } from '../src/artifact.js';
import { testDatabaseUrl } from './helpers/postgres.js';
import type { Scenario } from '../src/types.js';

const databaseUrl = testDatabaseUrl();
function scenario(setupSql = '', onActor = () => {}): Scenario {
  const actor: Scenario['actors'][string] = async ({ connectionString }) => {
    onActor();
    const client = new Client({ connectionString }); await client.connect();
    try { return (await client.query('SELECT value FROM counter')).rows[0].value; }
    finally { await client.end(); }
  };
  return {
    name: 'fixture-bound-replay',
    async setup({ db }) { await db.query('CREATE TABLE counter(value integer); INSERT INTO counter VALUES(1)'); if (setupSql) await db.query(setupSql); },
    actors: { alice: actor, bob: actor },
    async invariant() { assert.fail('The same application assertion'); },
  };
}

describe('fixture-bound replay on real PostgreSQL', () => {
  test('unchanged fixture identity survives disposable names and exact artifact serialization', async () => {
    const first = await runOnce(scenario(), { databaseUrl });
    expect(first.outcome).toBe('violation');
    const identity = (first.environment as Record<string, unknown>).fixture;
    expect(identity).toMatchObject({ version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256' });
    const second = await replay(scenario(), parseRunArtifact(JSON.stringify(first)), { databaseUrl });
    expect(second.outcome).toBe('violation');
    expect((second.environment as Record<string, unknown>).fixture).toEqual(identity);
    expect(second.failure?.fingerprint).toBe(first.failure?.fingerprint);
  });
  test.each([
    ['initial data', 'UPDATE counter SET value=2'],
    ['schema', 'ALTER TABLE counter ADD COLUMN extra text'],
    ['function', 'CREATE FUNCTION fixture_answer() RETURNS integer LANGUAGE sql AS $$ SELECT 42 $$'],
    ['sequence', 'CREATE SEQUENCE fixture_sequence START 7'],
  ])('changed %s cannot replay unchanged queries and assertion text', async (_label, change) => {
    const first = await runOnce(scenario(), { databaseUrl });
    let invoked = 0;
    const second = await replay(scenario(change, () => invoked++), first, { databaseUrl });
    expect(second.outcome).toBe('incompatible');
    expect(second.reason).toMatch(/fixture/i);
    expect(second.trace).toEqual([]); expect(invoked).toBe(0); expect(second.cleanup.complete).toBe(true);
  });
  test('a development artifact without fixture provenance is explicit incompatible, while guided execution captures fresh provenance', async () => {
    const first = await runOnce(scenario(), { databaseUrl });
    delete (first.environment as Record<string, unknown>).fixture;
    const exact = await replay(scenario(), first, { databaseUrl });
    expect(exact.outcome).toBe('incompatible'); expect(exact.reason).toMatch(/fixture/i);
    const guided = await replay(scenario(), first, { databaseUrl, mode: 'guided' });
    expect(guided.outcome).toBe('violation'); expect(guided.mode).toBe('guided');
    expect((guided.environment as Record<string, unknown>).fixture).toBeDefined();
  });
  test('uncommitted setup is rejected before actor execution and its database is cleaned', async () => {
    let invoked = 0;
    const run = await runOnce(scenario('BEGIN; UPDATE counter SET value=2', () => invoked++), { databaseUrl });
    expect(run.outcome).toBe('harness-error'); expect(run.reason).toMatch(/committed|quiescent/i);
    expect(invoked).toBe(0); expect(run.cleanup.complete).toBe(true);
  });
  test('changed runtime and effective database settings are incompatible before actors start', async () => {
    const first = await runOnce(scenario(), { databaseUrl });
    let invoked = 0;
    const changedRuntime = structuredClone(first); changedRuntime.environment.nodeVersion = 'v0.0.0';
    const runtime = await replay(scenario('', () => invoked++), changedRuntime, { databaseUrl });
    expect(runtime.outcome).toBe('incompatible'); expect(runtime.reason).toMatch(/Node.js/); expect(invoked).toBe(0);
    const settings = scenario('', () => invoked++);
    const setup = settings.setup;
    settings.setup = async context => { await setup(context); await context.db.query(`ALTER DATABASE "${new URL(context.connectionString).pathname.slice(1)}" SET timezone='Asia/Kolkata'`); };
    const changed = await replay(settings, first, { databaseUrl });
    expect(changed.outcome).toBe('incompatible'); expect(changed.reason).toMatch(/fixture.*settings/); expect(invoked).toBe(0);
  });
  test('unsupported fixture state cannot produce an apparently bound pass or violation', async () => {
    let invoked = 0;
    const run = await runOnce(scenario('CREATE TYPE span AS RANGE(subtype=integer)', () => invoked++), { databaseUrl });
    expect(run.outcome).toBe('inconclusive'); expect(run.reason).toMatch(/Fixture identity does not yet cover/);
    expect(invoked).toBe(0); expect(run.cleanup.complete).toBe(true);
  });
});
