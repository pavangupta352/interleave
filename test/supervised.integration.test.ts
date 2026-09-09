import { testDatabaseUrl } from './helpers/postgres.js';
import { fileURLToPath } from 'node:url';
import { Client, escapeIdentifier } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({ names: [] as string[], failures: [] as unknown[] }));
vi.mock('../src/database.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/database.js')>();
  return { ...actual, async createOwnedDatabase(url: string) {
    try {
      const owned = await actual.createOwnedDatabase(url);
      lifecycle.names.push(owned.name);
      return owned;
    } catch (error) { lifecycle.failures.push(error); throw error; }
  } };
});
import { runScenarioFile } from '../src/supervised.js';
import { parseRunArtifact } from '../src/artifact.js';
import { OwnedDatabaseCreationError } from '../src/database.js';

const databaseUrl = testDatabaseUrl();
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/supervised/${name}.ts`, import.meta.url));

describe('supervised scenario integration', () => {
  const admin = new Client({ connectionString: databaseUrl });
  admin.on('error', () => undefined);
  beforeAll(async () => { await admin.connect(); });
  afterAll(async () => { await admin.end(); });
  afterEach(async () => {
    const names = lifecycle.names.splice(0);
    lifecycle.failures.splice(0);
    const remaining = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names]);
    expect(remaining.rows).toEqual([]);
    expect((await admin.query('SELECT current_database() AS name')).rows[0].name).toBe(decodeURIComponent(new URL(databaseUrl).pathname.slice(1)));
  });

  test('runs real failed and passing schedules and replays exact query identities', async () => {
    const failed = await runScenarioFile(fixture('counter'), { databaseUrl, plan: ['alice', 'bob', 'alice', 'bob'] });
    expect(failed.outcome).toBe('violation');
    expect(failed.trace).toHaveLength(4);
    expect(failed.cleanup.complete).toBe(true);
    expect(parseRunArtifact(failed)).toEqual(failed);
    const replayed = await runScenarioFile(fixture('counter'), { databaseUrl, replay: failed });
    expect(replayed.outcome).toBe('violation');
    expect(replayed.trace.map(step => step.fingerprint)).toEqual(failed.trace.map(step => step.fingerprint));
    const passed = await runScenarioFile(fixture('counter'), { databaseUrl, plan: ['alice', 'alice', 'bob', 'bob'] });
    expect(passed.outcome).toBe('passed');
    const changed = await runScenarioFile(fixture('changed-counter'), { databaseUrl, replay: failed });
    expect(changed.outcome).toBe('incompatible');
  });

  test('records actual PostgreSQL query rejection as actor error', async () => {
    const result = await runScenarioFile(fixture('query-error'), { databaseUrl });
    expect(result.outcome).toBe('actor-error');
    expect(result.actors.every(actor => actor.status === 'rejected')).toBe(true);
    expect(result.trace.every(step => step.completion?.error?.code === '42P01')).toBe(true);
    expect(parseRunArtifact(result)).toEqual(result);
  });

  test.each(['import-throws', 'exits', 'invalid-result', 'signal-exits'])('contains %s and cleans up the parent-owned database', async name => {
    const result = await runScenarioFile(fixture(name), { databaseUrl });
    expect(result.outcome).toBe('harness-error');
    expect(result.cleanup.complete).toBe(true);
    expect(parseRunArtifact(result)).toEqual(result);
    expect(lifecycle.names).toHaveLength(1);
  });

  test.each(['hung-setup', 'hung-actor'])('bounds %s with the supervisor deadline', async name => {
    const started = Date.now();
    const result = await runScenarioFile(fixture(name), { databaseUrl, timeoutMs: 1_000 });
    expect(result.outcome).toBe('inconclusive');
    expect(result.reason).toMatch(/deadline/);
    expect(result.cleanup.complete).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('external cancellation contains an unhandled idle pg client crash', async () => {
    const controller = new AbortController();
    const running = runScenarioFile(fixture('idle-cancel'), { databaseUrl, signal: controller.signal });
    try {
      const deadline = Date.now() + 5_000;
      let idle = false;
      while (Date.now() < deadline) {
        const activity = await admin.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND query = 'SELECT 1' AND state = 'idle'`,
          [lifecycle.names],
        );
        if (activity.rows.length > 0) { idle = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(idle).toBe(true);
      controller.abort();
      const result = await running;
      expect(result.outcome).toBe('inconclusive');
      expect(result.reason).toMatch(/cancelled/);
      expect(result.reason).toMatch(/exit 1/);
      expect(result.cleanup.complete).toBe(true);
      expect(parseRunArtifact(result)).toEqual(result);
      expect(lifecycle.names).toHaveLength(1);
    } finally { controller.abort(); await running; }
  });

  test('already aborted work does not create a database', async () => {
    const result = await runScenarioFile(fixture('counter'), { databaseUrl, signal: AbortSignal.abort() });
    expect(result.outcome).toBe('inconclusive');
    expect(result.cleanup.complete).toBe(true);
    expect(lifecycle.names).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')('terminates descendants after the worker finishes', async () => {
    const result = await runScenarioFile(fixture('descendant'), { databaseUrl });
    expect(result.outcome).toBe('passed');
    const pid = result.actors[0]?.value as number;
    expect(Number.isSafeInteger(pid)).toBe(true);
    const deadline = Date.now() + 2_000;
    let alive = true;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch { alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(alive).toBe(false);
  });

  test('preserves exact private SQL and selected observations without automatically recording logs or authentication fields', async () => {
    const result = await runScenarioFile(fixture('secret-output'), { databaseUrl });
    const sql = "SELECT 'postgresql://report-reader@example.invalid/reporting'::text AS selected";
    expect(result.outcome).toBe('passed');
    expect(result.trace.map(step => step.sql)).toEqual([sql, sql]);
    const observation = result.actors[0]?.value as { connectionString: string; selected: string };
    expect(observation.selected).toBe('postgresql://report-reader@example.invalid/reporting');
    expect(new URL(observation.connectionString).password).toBe(new URL(databaseUrl).password);
    expect(JSON.stringify(result)).not.toContain('SUPERVISED_UNRECORDED_LOG_SENTINEL');
    expect(result).not.toHaveProperty('logs');
    expect(result).not.toHaveProperty('authentication');
    expect(result.trace.every(step => !('backendKey' in step) && !('cancelKey' in step))).toBe(true);
    expect(parseRunArtifact(result)).toEqual(result);
    const replay = await runScenarioFile(fixture('secret-output'), { databaseUrl, replay: result });
    expect(replay.outcome).toBe('passed');
    expect(replay.trace.map(step => step.sql)).toEqual([sql, sql]);
    expect(replay.trace.map(step => step.fingerprint)).toEqual(result.trace.map(step => step.fingerprint));
  });

  test('preserves incomplete cleanup and exact generated identity when creation recovery fails', async () => {
    const originalQuery = Client.prototype.query;
    const originalConnect = Client.prototype.connect;
    let created = '';
    const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
      const result = Reflect.apply(originalQuery, this, args) as Promise<unknown>;
      const match = typeof args[0] === 'string' ? /^CREATE DATABASE "(interleave_[a-f0-9]+)"$/.exec(args[0]) : null;
      return match ? result.then(value => { created = match[1]!; return value; }) : result;
    } as typeof originalQuery);
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client, ...args: unknown[]) {
      return created ? Promise.reject(new Error('INJECTED_PRIVATE_CONNECTION_CREDENTIAL')) : Reflect.apply(originalConnect, this, args);
    } as typeof originalConnect);
    try {
      const result = await runScenarioFile(fixture('counter'), { databaseUrl });
      expect(created).toMatch(/^interleave_[a-f0-9]+$/);
      expect(result.outcome).toBe('harness-error');
      expect(result.cleanup.complete).toBe(false);
      expect(result.cleanup.error).toContain(created);
      const failure = lifecycle.failures[0] as OwnedDatabaseCreationError;
      expect(failure).toBeInstanceOf(OwnedDatabaseCreationError);
      expect(failure.databaseName).toBe(created);
      expect(failure.cleanupComplete).toBe(false);
      expect(failure.cause).toMatchObject({ message: 'INJECTED_PRIVATE_CONNECTION_CREDENTIAL' });
      expect(JSON.stringify(result)).not.toContain('INJECTED_PRIVATE_CONNECTION_CREDENTIAL');
      expect(result.reason).toContain(created);
      expect(parseRunArtifact(result)).toEqual(result);
      const remaining = await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [created]);
      expect(remaining.rows).toEqual([{ datname: created }]);
    } finally {
      query.mockRestore(); connect.mockRestore();
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(created)} WITH (FORCE)`);
    }
  });
});
