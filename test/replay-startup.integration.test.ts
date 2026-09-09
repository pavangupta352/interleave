import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
function scenario(configuration: { application_name?: string; options?: string }): Scenario {
  const actor: Scenario['actors'][string] = async ({ connectionString }) => {
    const client = new Client({ connectionString, ...configuration }); await client.connect();
    try { await client.query("SELECT current_setting('application_name'), current_setting('app.tenant',true), current_setting('timezone')"); }
    finally { await client.end(); }
  };
  return { name: 'actor-startup-binding', async setup() {}, actors: { alice: actor, bob: actor }, async invariant() { assert.fail('The same invariant failure'); } };
}
function reconnectScenario(firstApplicationName: string): Scenario {
  const actor: Scenario['actors'][string] = async ({ connectionString }) => {
    const first = new Client({ connectionString, application_name: firstApplicationName });
    await first.connect(); await first.end();
    const second = new Client({ connectionString, application_name: 'stable-query-startup' });
    await second.connect();
    try { await second.query('SELECT 1'); } finally { await second.end(); }
  };
  return {
    name: 'actor-queryless-reconnect-binding',
    async setup() {},
    actors: { alice: actor, bob: actor },
    async invariant() { assert.fail('The same reconnect invariant failure'); },
  };
}
test.each([
  [{ application_name: 'first-app' }, { application_name: 'second-app' }],
  [{ options: '-c app.tenant=first-tenant' }, { options: '-c app.tenant=second-tenant' }],
  [{ options: '-c timezone=UTC' }, { options: '-c timezone=Asia/Kolkata' }],
])('exact replay rejects changed actor startup semantics while fixture and SQL stay the same: %j', async (original, changed) => {
  const first = await runOnce(scenario(original), { databaseUrl });
  expect(first.outcome).toBe('violation');
  const second = await replay(scenario(changed), first, { databaseUrl });
  expect(second.environment.fixture?.fingerprint).toBe(first.environment.fixture?.fingerprint);
  expect(second.outcome).toBe('incompatible'); expect(second.reason).toMatch(/identity|startup/i);
  expect(second.trace).toHaveLength(0); expect(second.cleanup.complete).toBe(true);
});
test('unchanged startup remains replayable across fresh database names and does not expose startup values', async () => {
  const input = scenario({ options: '-c app.tenant=private-startup-tenant', application_name: 'bound-actor' });
  const first = await runOnce(input, { databaseUrl });
  const second = await replay(input, first, { databaseUrl });
  expect(first.outcome).toBe('violation'); expect(second.outcome).toBe('violation');
  expect(second.trace.map(step => step.fingerprint)).toEqual(first.trace.map(step => step.fingerprint));
  expect(JSON.stringify(first)).not.toContain('private-startup-tenant');
  expect(second.cleanup.complete).toBe(true);
});
test('exact replay binds a queryless startup before a later query-bearing reconnect', async () => {
  const originalValue = 'private-queryless-original';
  const changedValue = 'private-queryless-changed';
  const first = await runOnce(reconnectScenario(originalValue), { databaseUrl });
  expect(first.outcome).toBe('violation');
  expect(first.connections?.filter(identity => identity.actor === 'alice').map(identity => identity.connection)).toEqual([0, 1]);
  expect(first.connections?.filter(identity => identity.actor === 'bob').map(identity => identity.connection)).toEqual([0, 1]);

  const second = await replay(reconnectScenario(changedValue), first, { databaseUrl });

  expect(second.outcome).toBe('incompatible');
  expect(second.reason).toMatch(/startup identity changed/i);
  expect(second.trace).toHaveLength(0);
  expect(JSON.stringify(first)).not.toContain(originalValue);
  expect(JSON.stringify(second)).not.toContain(changedValue);
  expect(second.cleanup.complete).toBe(true);
});
