import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { testDatabaseUrl } from './helpers/postgres.js';
import { replay } from '../src/replay.js';
import { runOnce } from '../src/runner.js';
import scenario from './fixtures/process/scenario.js';

const databaseUrl = testDatabaseUrl();

test('separate operating-system processes race through their own actor endpoints and replay exactly', async () => {
  const recorded = await runOnce(scenario, { databaseUrl });
  expect(recorded.outcome, recorded.reason).toBe('violation');
  expect(recorded.actors.map(actor => actor.value)).toEqual([{ read: 0, wrote: 1 }, { read: 0, wrote: 1 }]);
  expect(recorded.trace.map(step => `${step.actor}:${step.sql.split(' ')[0]}`)).toEqual(['alice:SELECT', 'bob:SELECT', 'alice:UPDATE', 'bob:UPDATE']);
  const repeated = await replay(scenario, recorded, { databaseUrl });
  expect(repeated.outcome, repeated.reason).toBe('violation');
  const serial = await runOnce(scenario, { databaseUrl, plan: ['alice', 'alice', 'bob', 'bob'] });
  expect(serial.outcome, serial.reason).toBe('passed');
  expect(serial.actors.map(actor => actor.value)).toEqual([{ read: 0, wrote: 1 }, { read: 1, wrote: 2 }]);
});
