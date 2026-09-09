import assert from 'node:assert/strict';
import type { ActorContext, Scenario } from '../../src/types.js';
import * as drizzle from './drizzle.js';
import * as kysely from './kysely.js';

export type Orm = 'drizzle' | 'kysely';
export type Behavior = 'lost-update' | 'atomic' | 'crud-rollback' | 'serializable-retry' | 'serializable-error';

export function createOrmScenario(orm: Orm, behavior: Behavior = 'lost-update'): Scenario {
  if (!['drizzle', 'kysely'].includes(orm)) throw new TypeError('Unknown ORM');
  if (!['lost-update', 'atomic', 'crud-rollback', 'serializable-retry', 'serializable-error'].includes(behavior)) throw new TypeError('Unknown behavior');
  const api = orm === 'drizzle' ? drizzle : kysely;
  const operation = behavior === 'lost-update' ? api.lostUpdate : behavior === 'atomic' ? api.atomic : behavior === 'crud-rollback' ? api.crudRollback
    : (context: ActorContext) => api.serializable(context, behavior === 'serializable-retry');
  return {
    name: `${orm}-${behavior}`,
    async setup({ db }) {
      await db.query('CREATE TABLE counter (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO counter VALUES (1,0)');
      await db.query('CREATE TABLE entries (id integer PRIMARY KEY, value integer NOT NULL)');
      await db.query('CREATE TABLE attempts (actor text PRIMARY KEY, commits integer NOT NULL)');
    },
    actors: { alice: operation, bob: operation },
    async invariant({ db, results }) {
      if (behavior === 'crud-rollback') {
        assert.deepEqual((await db.query('SELECT * FROM entries')).rows, []);
        assert.deepEqual(results.map(actor => actor.value), Array.from({ length: 2 }, () => ({ inserted: 1, updated: 2, committed: 2, code: '23505', rolledBack: true, deleted: 2 })));
      } else {
        assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 2, 'Expected both increments to be retained');
        if (behavior === 'serializable-retry' || behavior === 'serializable-error') {
          assert.deepEqual((await db.query('SELECT actor, commits FROM attempts ORDER BY actor')).rows, [{ actor: 'alice', commits: 1 }, { actor: 'bob', commits: 1 }]);
        }
      }
    },
  };
}
