import { Client } from 'pg';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { explorationExitCode, runExitCode } from '../src/cli/status.js';
import { explore } from '../src/explore.js';
import { runOnce } from '../src/runner.js';
import { runScenarioFile } from '../src/supervised.js';
import type { RunResult, Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const applicationError = 'Application rejected before harness interruption';

async function assertRemoved(names: string[]): Promise<void> {
  expect(names.length).toBeGreaterThan(0);
  expect(names.every(name => /^interleave_[a-f0-9]+$/.test(name))).toBe(true);
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const remaining = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names]);
    expect(remaining.rows).toEqual([]);
    console.log(JSON.stringify({ actorFailurePrecedence: { ownedDatabases: names, remaining: remaining.rows } }));
  } finally { await admin.end(); }
}

function scenario(actors: Scenario['actors']) {
  const names: string[] = [];
  let invariantCalls = 0;
  const input: Scenario = {
    name: 'actor-failure-precedence',
    async setup({ db }) { names.push((await db.query('SELECT current_database() AS name')).rows[0].name); },
    actors,
    async invariant() { invariantCalls++; },
  };
  return { input, names, invariantCalls: () => invariantCalls };
}

function assertHardPartial(run: RunResult): void {
  expect(run.cleanup.complete).toBe(true);
  expect(parseRunArtifact(run)).toEqual(run);
  expect(run.actors).toEqual([{ actor: 'a', status: 'rejected', error: applicationError }]);
  expect(run.trace).toEqual([]);
  expect(run.outcome).toBe('harness-error');
  expect(run.reason).toMatch(/application.*reject/i);
  expect(run.reason).toMatch(/deadline|cancel/i);
  expect(runExitCode(run)).toBe(2);
}

test('an early application rejection remains a hard failure when a queryless actor reaches the deadline', async () => {
  const fixture = scenario({ async a() { throw new Error(applicationError); }, async b() { await new Promise(() => {}); } });
  try {
    const run = await runOnce(fixture.input, { databaseUrl, timeoutMs: 1500 });
    assertHardPartial(run);
    expect(fixture.invariantCalls()).toBe(0);
  } finally { await assertRemoved(fixture.names); }
});

test('exploration counts an application rejection observed before cancellation as a hard partial run', async () => {
  const controller = new AbortController();
  const fixture = scenario({
    async a() { throw new Error(applicationError); },
    async b() { setTimeout(() => controller.abort(), 25); await new Promise(() => {}); },
  });
  try {
    const search = await explore(fixture.input, { databaseUrl, signal: controller.signal, maxRuns: 2, timeoutMs: 3000 });
    expect(search.runs).toHaveLength(1);
    assertHardPartial(search.runs[0]!);
    expect(search.hardFailureCount).toBe(1);
    expect(explorationExitCode(search)).toBe(2);
    expect(search.metrics.completedRuns).toBe(0);
    expect(search.metrics.traceCountsComplete).toBe(false);
    expect(fixture.invariantCalls()).toBe(0);
  } finally { await assertRemoved(fixture.names); }
});

test.each(['actor', 'caller'] as const)('actor rejections caused by the %s abort signal remain inconclusive', async route => {
  const controller = new AbortController();
  const aborted: Scenario['actors'][string] = async ({ signal }) => new Promise((_resolve, reject) => {
    (route === 'actor' ? signal : controller.signal).addEventListener('abort', () => reject(new Error('Application stopped in response to the harness abort')), { once: true });
    setTimeout(() => controller.abort(), 25);
  });
  const fixture = scenario({ a: aborted, b: aborted });
  try {
    const run = await runOnce(fixture.input, { databaseUrl, signal: controller.signal, timeoutMs: 3000 });
    expect(run.actors).toHaveLength(2);
    expect(run.actors.every(actor => actor.status === 'rejected')).toBe(true);
    expect(run.outcome).toBe('inconclusive');
    expect(run.reason).toMatch(/cancel/i);
    expect(runExitCode(run)).toBe(4);
    expect(run.cleanup.complete).toBe(true);
    expect(parseRunArtifact(run)).toEqual(run);
    expect(fixture.invariantCalls()).toBe(0);
  } finally { await assertRemoved(fixture.names); }
});

test('an early actor failure stays hard when its partial evidence must be omitted to fit', async () => {
  const fixture = scenario({
    async a() { throw new Error(`${applicationError}: ${'x'.repeat(8000)}`); },
    async b() { await new Promise(() => {}); },
  });
  try {
    const run = await runOnce(fixture.input, { databaseUrl, timeoutMs: 1500, maxEvidenceBytes: 2048 });
    expect(run.outcome).toBe('harness-error');
    expect(run.actors).toEqual([]);
    expect(run.trace).toEqual([]);
    expect(run.reason).toMatch(/evidence|recording limits/);
    expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThanOrEqual(2048);
    expect(run.cleanup.complete).toBe(true);
    expect(parseRunArtifact(run)).toEqual(run);
    expect(runExitCode(run)).toBe(2);
  } finally { await assertRemoved(fixture.names); }
});

test('a real query rejected by deadline cleanup does not become an application hard failure', async () => {
  const fixture = scenario({
    async a({ connectionString }) {
      const client = new Client({ connectionString });
      client.on('error', () => {});
      await client.connect();
      try { await client.query('SELECT pg_sleep(10)'); } finally { await client.end(); }
    },
    async b() {},
  });
  try {
    const run = await runOnce(fixture.input, { databaseUrl, timeoutMs: 1500 });
    expect(run.trace).toHaveLength(1);
    expect(run.trace[0]!.sql).toBe('SELECT pg_sleep(10)');
    expect(run.trace[0]!.completion).toBeUndefined();
    expect(run.actors.find(actor => actor.actor === 'a')?.status).toBe('rejected');
    expect(run.outcome).toBe('inconclusive');
    expect(run.reason).toMatch(/deadline/);
    expect(run.cleanup.complete).toBe(true);
    expect(parseRunArtifact(run)).toEqual(run);
    expect(fixture.invariantCalls()).toBe(0);
  } finally { await assertRemoved(fixture.names); }
});

test('the supervisor retains a worker application rejection before its parent deadline', async () => {
  const file = fileURLToPath(new URL('./fixtures/supervised/rejected-and-hung.ts', import.meta.url));
  const run = await runScenarioFile(file, { databaseUrl, timeoutMs: 4000 });
  const error = run.actors.find(actor => actor.actor === 'a')?.error ?? '';
  const names = [...error.matchAll(/interleave_[a-f0-9]+/g)].map(match => match[0]);
  await assertRemoved(names);
  expect(error).toContain(applicationError);
  expect(run.outcome).toBe('harness-error');
  expect(run.reason).toMatch(/application.*reject/i);
  expect(run.reason).toMatch(/deadline|cancel/i);
  expect(run.actors).toHaveLength(1);
  expect(run.cleanup.complete).toBe(true);
  expect(runExitCode(run)).toBe(2);
  expect(parseRunArtifact(run)).toEqual(run);
});
