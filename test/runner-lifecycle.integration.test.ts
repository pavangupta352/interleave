import { Client, escapeIdentifier } from 'pg';
import { expect, test, vi } from 'vitest';
import { runOnce } from '../src/runner.js';
import { explore } from '../src/explore.js';
import { parseRunArtifact } from '../src/artifact.js';
import { explorationExitCode } from '../src/cli/status.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const empty: Scenario = { name: 'lifecycle-budget', setup: async () => {}, actors: { a: async () => {}, b: async () => {} }, invariant: async () => {} };

test('runner integration preserves failed recovery after a confirmed database creation', async () => {
  const originalQuery = Client.prototype.query;
  const originalConnect = Client.prototype.connect;
  let created = '';
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: any[]): any {
    const operation = (originalQuery as any).apply(this, args);
    if (typeof args[0] === 'string' && /^CREATE DATABASE "interleave_[a-f0-9]+"$/.test(args[0])) {
      return operation.then((value: unknown) => { created = /"(interleave_[a-f0-9]+)"/.exec(args[0])![1]!; return value; });
    }
    return operation;
  });
  const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(function(this: Client, ...args: any[]): any {
    return created ? Promise.reject(new Error('Injected outage after confirmed creation')) : (originalConnect as any).apply(this, args);
  });
  let run;
  try { run = await runOnce(empty, { databaseUrl }); }
  finally { query.mockRestore(); connect.mockRestore(); }
  expect(created).toMatch(/^interleave_/);
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [created])).rowCount).toBe(1);
    expect(run.outcome).toBe('harness-error');
    expect(run.cleanup.complete).toBe(false);
    expect(run.cleanup.error).toContain(created);
    expect(parseRunArtifact(run)).toEqual(run);
  } finally { await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(created)} WITH(FORCE)`); await admin.end(); }
});

test('runner integration stops before releasing SQL that exceeds the evidence budget', async () => {
  const actor: Scenario['actors'][string] = async ({ connectionString }) => {
    const client = new Client({ connectionString });
    client.on('error', () => undefined);
    await client.connect();
    try { await client.query('SELECT 1 /*' + 'x'.repeat(2000) + '*/'); } finally { await client.end(); }
  };
  const run = await runOnce({ ...empty, actors: { a: actor, b: actor } }, { databaseUrl, maxEvidenceBytes: 2048 });
  expect(run.outcome).toBe('inconclusive');
  expect(run.reason).toMatch(/evidence|byte/i);
  expect(run.trace).toHaveLength(0);
  expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThanOrEqual(2048);
  expect(parseRunArtifact(run)).toEqual(run);
});

test('runner integration omits an oversized actor observation with an explicit nonpassing outcome', async () => {
  const run = await runOnce({ ...empty, actors: { async a() { return 'x'.repeat(8000); }, async b() {} } }, { databaseUrl, maxEvidenceBytes: 2048 });
  expect(run.outcome).toBe('inconclusive');
  expect(run.reason).toMatch(/evidence|byte/i);
  expect(run.actors.every(actor => actor.value === undefined)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThanOrEqual(2048);
  expect(parseRunArtifact(run)).toEqual(run);
});

test('runner integration rejects a byte ceiling too small for exact scenario identity before setup', async () => {
  let setupRan = false;
  await expect(runOnce({ ...empty, name: '界'.repeat(256), async setup() { setupRan = true; } }, { databaseUrl, maxEvidenceBytes: 1024 })).rejects.toThrow(/maxEvidenceBytes.*identity/i);
  expect(setupRan).toBe(false);
});

test.each(['actor', 'setup'] as const)('oversized %s failure evidence preserves a hard-failure exit within its byte cap', async phase => {
  const failure = new Error(`${phase} failed: ${'x'.repeat(8000)}`);
  let actorInvocations = 0;
  // Actor failures must get past fixture capture; setup failures precede it.
  const byteCap = phase === 'actor' ? 2048 : 1024;
  const scenario: Scenario = {
    ...empty,
    name: `oversized-${phase}-failure`,
    async setup({ db }) {
      await db.query('SELECT 1');
      if (phase === 'setup') throw failure;
    },
    actors: { async a() { actorInvocations++; if (phase === 'actor') throw failure; }, async b() {} },
  };
  const direct = await runOnce(scenario, { databaseUrl, maxEvidenceBytes: byteCap });
  const search = await explore(scenario, { databaseUrl, maxEvidenceBytes: byteCap });
  expect(actorInvocations).toBe(phase === 'actor' ? 2 : 0);
  expect(search.runs).toHaveLength(1);
  for (const run of [direct, search.runs[0]!]) {
    expect(run.cleanup.complete).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThanOrEqual(byteCap);
    expect(parseRunArtifact(run)).toEqual(run);
    expect.soft(['actor-error', 'harness-error']).toContain(run.outcome);
  }
  expect.soft(search.hardFailureCount).toBe(1);
  expect.soft(explorationExitCode(search)).toBe(2);
});
