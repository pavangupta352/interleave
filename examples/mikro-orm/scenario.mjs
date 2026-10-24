import assert from 'node:assert/strict';
import { EntitySchema, IsolationLevel, raw } from '@mikro-orm/core';
import { withMikroOrmActor } from './connection.mjs';

const integer = { type: 'integer' };
// Primary keys are assigned by the application, never generated.
const Counter = new EntitySchema({ name: 'Counter', tableName: 'counter', properties: {
  id: { ...integer, primary: true, autoincrement: false }, value: integer,
} });
const Entry = new EntitySchema({ name: 'Entry', tableName: 'entries', properties: {
  id: { ...integer, primary: true, autoincrement: false }, value: integer,
} });
// One committed marker per actor records which transaction attempt committed.
const Attempt = new EntitySchema({ name: 'Attempt', tableName: 'attempts', properties: {
  actor: { type: 'text', primary: true }, attempt: integer,
} });
const entities = [Counter, Entry, Attempt];
const behaviors = ['lost-update', 'atomic', 'crud-rollback', 'serializable-retry', 'serializable-error'];

// Both behaviors read the counter first and flush one change. The unsafe one
// assigns the value it read plus one; the atomic one assigns a raw SQL
// increment, and MikroORM reads the new value back when it flushes.
async function increment(em, atomic) {
  const counter = await em.findOneOrFail(Counter, 1);
  const read = counter.value;
  counter.value = atomic ? raw('value + 1') : read + 1;
  await em.flush();
  return { read, written: counter.value };
}

async function crudRollback(em, actor) {
  const id = actor === 'alice' ? 1 : 2, marker = id + 10;
  let inserted, updated, code;
  await em.transactional(async tx => {
    const entry = tx.create(Entry, { id, value: 1 });
    await tx.flush();
    // refresh makes each read a query instead of an identity-map lookup.
    inserted = (await tx.findOneOrFail(Entry, id, { refresh: true })).value;
    entry.value = 2;
    await tx.flush();
    updated = (await tx.findOneOrFail(Entry, id, { refresh: true })).value;
  });
  // A marker write followed by a duplicate primary key must roll back together.
  // Clearing the identity map lets the duplicate reach PostgreSQL.
  em.clear();
  try {
    await em.transactional(async tx => {
      tx.create(Entry, { id: marker, value: 99 });
      await tx.flush();
      tx.create(Entry, { id, value: 100 });
      await tx.flush();
    });
  } catch (error) {
    code = error?.code;
    if (code !== '23505') throw error;
  }
  if (code === undefined) throw new Error('The duplicate insert unexpectedly committed');
  // The same actor connection keeps working after ROLLBACK.
  em.clear();
  const committed = (await em.findOneOrFail(Entry, id)).value;
  const markerRows = await em.count(Entry, { id: marker });
  const deleted = await em.nativeDelete(Entry, { id });
  return { inserted, updated, code, committed, markerRows, deleted };
}

const SERIALIZATION_FAILURE = '40001', ATTEMPT_LIMIT = 3;

// A retry restarts the whole transaction: a new snapshot, a fresh read and a
// new marker. Only the serialization failure SQLSTATE is retried.
async function serializable(em, actor, retry) {
  const reads = [], errors = [];
  let rollbackVerified = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await em.transactional(async tx => {
        tx.create(Attempt, { actor, attempt });
        await tx.flush();
        const counter = await tx.findOneOrFail(Counter, 1);
        reads.push(counter.value);
        counter.value += 1;
      }, { isolationLevel: IsolationLevel.SERIALIZABLE });
      return { attempts: attempt, reads, errors, rollbackVerified };
    } catch (error) {
      // The failed attempt's marker must be gone before anything else runs.
      em.clear();
      assert.deepEqual(await em.find(Attempt, { actor }), [], 'A failed attempt must roll back its marker');
      rollbackVerified = true;
      const code = error?.code;
      if (!retry || code !== SERIALIZATION_FAILURE || attempt === ATTEMPT_LIMIT) throw error;
      errors.push(code);
    }
  }
}

export function createMikroOrmScenario(behavior = 'lost-update') {
  if (!behaviors.includes(behavior)) throw new TypeError(`Unknown MikroORM behavior: ${behavior}`);
  const operation = context => withMikroOrmActor(context, entities, em => {
    if (behavior === 'crud-rollback') return crudRollback(em, context.actor);
    if (behavior.startsWith('serializable-')) return serializable(em, context.actor, behavior === 'serializable-retry');
    return increment(em, behavior === 'atomic');
  });
  return {
    name: `mikro-orm-${behavior}`,
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

export default createMikroOrmScenario();
