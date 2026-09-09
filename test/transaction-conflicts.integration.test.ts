import assert from 'node:assert/strict';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { runOnce } from '../src/runner.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();

function deadlockScenario(handleError: boolean): Scenario {
  const update = (first: number, second: number): Scenario['actors'][string] => async ({ connectionString }) => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE accounts SET value = value + 1 WHERE id = $1', [first]);
      await client.query('UPDATE accounts SET value = value + 1 WHERE id = $1', [second]);
      await client.query('COMMIT');
      return { committed: true };
    } catch (error) {
      await client.query('ROLLBACK');
      if (!handleError) throw error;
      const code = (error as { code?: string }).code;
      assert.equal(code, '40P01');
      return { committed: false, code };
    } finally { await client.end(); }
  };
  return {
    name: 'real-deadlock',
    async setup({ db }) {
      await db.query('CREATE TABLE accounts (id int PRIMARY KEY, value int NOT NULL); INSERT INTO accounts VALUES (1,0),(2,0)');
    },
    actors: { alice: update(1, 2), bob: update(2, 1) },
    async invariant({ db, results }) {
      assert.equal(handleError, true, 'An unhandled database error must skip the invariant');
      assert.deepEqual((await db.query('SELECT value FROM accounts ORDER BY id')).rows, [{ value: 1 }, { value: 1 }]);
      assert.equal(results.filter(result => (result.value as { committed: boolean }).committed).length, 1);
    },
  };
}

test.each([true, false])('preserves a PostgreSQL deadlock and rollback with application handling=%s', async handleError => {
  const result = await runOnce(deadlockScenario(handleError), {
    databaseUrl, plan: ['alice', 'bob', 'alice', 'bob', 'alice', 'bob'],
  });
  expect(result.outcome, result.reason).toBe(handleError ? 'passed' : 'actor-error');
  const errors = result.trace.filter(step => step.completion?.error?.code === '40P01');
  expect(errors).toHaveLength(1);
  expect(errors[0]!.completion?.transactionStatus).toBe('E');
  expect(result.trace.filter(step => step.sql === 'ROLLBACK').map(step => step.completion?.transactionStatus)).toEqual(['I']);
  expect(result.trace[4]!.waits.some(wait => wait.waitEventType === 'Lock')).toBe(true);
  expect(result.trace.every(step => step.completion !== undefined)).toBe(true);
  expect(result.failure).toBeUndefined();
  expect(result.cleanup.complete).toBe(true);
});

function serializableRetryScenario(): Scenario {
  const increment: Scenario['actors'][string] = async ({ connectionString }) => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        try {
          const { rows } = await client.query({ name: 'read-counter', text: 'SELECT value FROM counter WHERE id = $1', values: [1] });
          await client.query({ name: 'write-counter', text: 'UPDATE counter SET value = $1 WHERE id = $2', values: [rows[0].value + 1, 1] });
          await client.query('COMMIT');
          return { attempts: attempt };
        } catch (error) {
          await client.query('ROLLBACK');
          if ((error as { code?: string }).code !== '40001' || attempt === 2) throw error;
        }
      }
      throw new Error('Retry limit was not enforced');
    } finally { await client.end(); }
  };
  return {
    name: 'serializable-whole-transaction-retry',
    async setup({ db }) {
      await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1,0)');
    },
    actors: { alice: increment, bob: increment },
    async invariant({ db, results }) {
      assert.equal((await db.query('SELECT value FROM counter WHERE id=1')).rows[0].value, 2);
      assert.deepEqual(results.map(result => (result.value as { attempts: number }).attempts).sort(), [1, 2]);
    },
  };
}

test('replays a real serialization failure and whole-transaction retry using cached prepared statements', async () => {
  const scenario = serializableRetryScenario();
  const recorded = await runOnce(scenario, {
    databaseUrl, plan: ['alice', 'bob', 'alice', 'bob', 'alice', 'bob', 'alice'],
  });
  expect(recorded.outcome, recorded.reason).toBe('passed');
  expect(recorded.trace).toHaveLength(12);
  const rejected = recorded.trace.filter(step => step.completion?.error?.code === '40001');
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.waits.some(wait => wait.waitEventType === 'Lock')).toBe(true);
  expect(rejected[0]!.completion?.transactionStatus).toBe('E');
  expect(recorded.cleanup.complete).toBe(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const replayed = await runOnce(scenario, { databaseUrl, replay: recorded });
    expect(replayed.outcome, replayed.reason).toBe('passed');
    expect(replayed.trace.map(step => step.fingerprint)).toEqual(recorded.trace.map(step => step.fingerprint));
    expect(replayed.trace.filter(step => step.completion?.error?.code === '40001')).toHaveLength(1);
    expect(replayed.cleanup.complete).toBe(true);
  }
});
