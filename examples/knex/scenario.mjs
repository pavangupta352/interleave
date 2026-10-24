import assert from 'node:assert/strict';
import { withKnexActor } from './connection.mjs';

const behaviors = ['lost-update', 'atomic', 'crud-rollback', 'serializable-retry', 'serializable-error'];

// Both behaviors read the counter first. The unsafe one writes the value it
// read plus one; the atomic one lets PostgreSQL add one to the current value.
async function increment(db, atomic) {
  const { value: read } = await db('counter').where({ id: 1 }).first('value');
  if (atomic) {
    const [{ value: written }] = await db('counter').where({ id: 1 }).increment('value', 1).returning('value');
    return { read, written };
  }
  await db('counter').where({ id: 1 }).update({ value: read + 1 });
  return { read, written: read + 1 };
}

async function crudRollback(db, actor) {
  const id = actor === 'alice' ? 1 : 2, marker = id + 10;
  let inserted, updated, code;
  await db.transaction(async trx => {
    await trx('entries').insert({ id, value: 1 });
    inserted = (await trx('entries').where({ id }).first('value')).value;
    await trx('entries').where({ id }).update({ value: 2 });
    updated = (await trx('entries').where({ id }).first('value')).value;
  });
  // A marker write followed by a duplicate primary key must roll back together.
  try {
    await db.transaction(async trx => {
      await trx('entries').insert({ id: marker, value: 99 });
      await trx('entries').insert({ id, value: 100 });
    });
  } catch (error) {
    code = error?.code;
    if (code !== '23505') throw error;
  }
  if (code === undefined) throw new Error('The duplicate insert unexpectedly committed');
  // The same actor connection keeps working after ROLLBACK.
  const committed = (await db('entries').where({ id }).first('value')).value;
  // PostgreSQL's count is a bigint, which node-postgres returns as a string.
  const markerRows = Number((await db('entries').where({ id: marker }).count({ rows: '*' }).first()).rows);
  const deleted = await db('entries').where({ id }).del();
  return { inserted, updated, code, committed, markerRows, deleted };
}

const SERIALIZATION_FAILURE = '40001', ATTEMPT_LIMIT = 3;

// A retry restarts the whole transaction: a new snapshot, a fresh read and a
// new marker. Only the serialization failure SQLSTATE is retried.
async function serializable(db, actor, retry) {
  const reads = [], errors = [];
  let rollbackVerified = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction(async trx => {
        await trx('attempts').insert({ actor, attempt });
        const { value } = await trx('counter').where({ id: 1 }).first('value');
        reads.push(value);
        await trx('counter').where({ id: 1 }).update({ value: value + 1 });
      }, { isolationLevel: 'serializable' });
      return { attempts: attempt, reads, errors, rollbackVerified };
    } catch (error) {
      // The failed attempt's marker must be gone before anything else runs.
      assert.deepEqual(await db('attempts').where({ actor }).select('actor', 'attempt'), [], 'A failed attempt must roll back its marker');
      rollbackVerified = true;
      const code = error?.code;
      if (!retry || code !== SERIALIZATION_FAILURE || attempt === ATTEMPT_LIMIT) throw error;
      errors.push(code);
    }
  }
}

export function createKnexScenario(behavior = 'lost-update') {
  if (!behaviors.includes(behavior)) throw new TypeError(`Unknown Knex behavior: ${behavior}`);
  const operation = context => withKnexActor(context, db => {
    if (behavior === 'crud-rollback') return crudRollback(db, context.actor);
    if (behavior.startsWith('serializable-')) return serializable(db, context.actor, behavior === 'serializable-retry');
    return increment(db, behavior === 'atomic');
  });
  return {
    name: `knex-${behavior}`,
    async setup({ db }) {
      await db.query('CREATE TABLE counter (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO counter VALUES (1, 0)');
      await db.query('CREATE TABLE entries (id integer PRIMARY KEY, value integer NOT NULL)');
      await db.query('CREATE TABLE attempts (actor text PRIMARY KEY, attempt integer NOT NULL)');
    },
    actors: { alice: operation, bob: operation },
    async invariant({ db, results }) {
      if (behavior === 'crud-rollback') {
        assert.deepEqual((await db.query('SELECT id, value FROM entries ORDER BY id')).rows, []);
        assert.deepEqual(results.map(result => result.value), Array(2).fill(
          { inserted: 1, updated: 2, code: '23505', committed: 2, markerRows: 0, deleted: 1 }));
        return;
      }
      assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 2, 'Expected both increments to be retained');
      // Exactly one committed marker per actor, written by its final attempt.
      if (behavior.startsWith('serializable-')) assert.deepEqual((await db.query('SELECT actor, attempt FROM attempts ORDER BY actor')).rows,
        results.map(result => ({ actor: result.actor, attempt: result.value.attempts })));
    },
  };
}

export default createKnexScenario();
