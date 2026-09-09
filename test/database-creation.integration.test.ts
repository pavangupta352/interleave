import { fileURLToPath } from 'node:url';
import { Client, DatabaseError, escapeIdentifier } from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createOwnedDatabase, OwnedDatabaseCreationError } from '../src/database.js';
import { runOnce } from '../src/runner.js';
import { runScenarioFile } from '../src/supervised.js';
import { parseRunArtifact } from '../src/artifact.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const admin = new Client({ connectionString: databaseUrl });
admin.on('error', () => undefined);
beforeAll(async () => { await admin.connect(); });
afterAll(async () => { await admin.end(); });

function serverError(code: string, severity: string): DatabaseError {
  const error = new DatabaseError('PRIVATE_ACKNOWLEDGEMENT_FAILURE', 0, 'error');
  error.code = code;
  error.severity = severity;
  return error;
}

// Execute the actual CREATE first, then lose its success at the driver boundary.
// The test alone knows ownership and removes the exact confirmed name in finally.
async function withLostAcknowledgement(
  error: Error,
  check: (createdName: () => string) => Promise<void>,
): Promise<void> {
  const originalQuery = Client.prototype.query;
  let created = '';
  const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
    const operation = Reflect.apply(originalQuery, this, args) as Promise<unknown>;
    const match = typeof args[0] === 'string' ? /^CREATE DATABASE "(interleave_[a-f0-9]+)"$/.exec(args[0]) : null;
    return match ? operation.then(() => { created = match[1]!; throw error; }) : operation;
  } as typeof originalQuery);
  try {
    await check(() => created);
  } finally {
    query.mockRestore();
    if (created) {
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(created)} WITH (FORCE)`);
      expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [created])).rows).toEqual([]);
    }
  }
}

test.each(['in-process', 'supervised'] as const)(
  '%s execution cannot report complete cleanup after an unacknowledged CREATE',
  async mode => {
    await withLostAcknowledgement(new Error('PRIVATE_ACKNOWLEDGEMENT_FAILURE'), async createdName => {
      const run = mode === 'in-process'
        ? await runOnce({ name: 'unconfirmed-create', async setup() {}, actors: { async a() {}, async b() {} }, async invariant() {} }, { databaseUrl })
        : await runScenarioFile(fileURLToPath(new URL('./fixtures/supervised/counter.ts', import.meta.url)), { databaseUrl });
      const name = createdName();
      expect(name).toMatch(/^interleave_[a-f0-9]{32}$/);
      expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([{ datname: name }]);
      expect(run.outcome).toBe('harness-error');
      expect(run.cleanup.complete).toBe(false);
      expect(run.cleanup.error).toContain(name);
      expect(run.reason).toMatch(/unknown|unconfirmed|could not be confirmed/i);
      expect(JSON.stringify(run)).not.toContain('PRIVATE_ACKNOWLEDGEMENT_FAILURE');
      expect(run.trace).toEqual([]);
      expect(parseRunArtifact(run)).toEqual(run);
    });
  },
);

test.each([
  ['fatal server termination', serverError('57P01', 'FATAL')],
  ['unknown statement completion', serverError('40003', 'ERROR')],
  ['unknown transaction resolution', serverError('08007', 'ERROR')],
  ['a localized server error severity', serverError('42P04', 'FEHLER')],
  ['transport error with a coincidental SQLSTATE', Object.assign(new Error('PRIVATE_ACKNOWLEDGEMENT_FAILURE'), { code: '42P04', severity: 'ERROR' })],
] as const)('keeps %s after CREATE as uncertain ownership', async (_label, injectedError) => {
  await withLostAcknowledgement(injectedError, async createdName => {
    let failure: unknown;
    try { await createOwnedDatabase(databaseUrl); } catch (error) { failure = error; }
    const name = createdName();
    expect(failure).toBeInstanceOf(OwnedDatabaseCreationError);
    expect(failure).toMatchObject({ databaseName: name, cleanupComplete: false });
    expect((failure as Error).cause).toBe(injectedError);
    expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([{ datname: name }]);
  });
});
