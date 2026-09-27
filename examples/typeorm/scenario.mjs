import assert from 'node:assert/strict';
import { EntitySchema } from 'typeorm';
import { withTypeOrmActor } from './connection.mjs';

const Counter = new EntitySchema({ name: 'Counter', tableName: 'counter', columns: {
  id: { type: Number, primary: true }, value: { type: Number },
} });
const Entry = new EntitySchema({ name: 'Entry', tableName: 'entries', columns: {
  id: { type: Number, primary: true }, value: { type: Number },
} });
// One committed marker per actor records which transaction attempt committed.
const Attempt = new EntitySchema({ name: 'Attempt', tableName: 'attempts', columns: {
  actor: { type: String, primary: true }, attempt: { type: Number },
} });
const entities = [Counter, Entry, Attempt];
const behaviors = ['lost-update', 'atomic', 'crud-rollback', 'serializable-retry', 'serializable-error'];

async function increment(runner, atomic) {
  if (atomic) {
    // TypeORM's PostgreSQL QueryRunner returns [rows, rowCount] for UPDATE.
    const [rows] = await runner.query('UPDATE counter SET value = value + $1 WHERE id = $2 RETURNING value', [1, 1]);
    return { written: rows[0].value };
  }
  const before = await runner.manager.findOneByOrFail(Counter, { id: 1 });
  await runner.manager.update(Counter, { id: 1 }, { value: before.value + 1 });
  return { read: before.value, written: before.value + 1 };
}

async function crudRollback(runner, actor) {
  const id = actor === 'alice' ? 1 : 2, marker = id + 10;
  let inserted, updated, code;
  await runner.startTransaction();
  try {
    await runner.manager.insert(Entry, { id, value: 1 });
    inserted = (await runner.manager.findOneByOrFail(Entry, { id })).value;
    await runner.manager.update(Entry, { id }, { value: 2 });
    updated = (await runner.manager.findOneByOrFail(Entry, { id })).value;
    await runner.commitTransaction();
  } catch (error) { await runner.rollbackTransaction(); throw error; }
  // A marker write followed by a duplicate primary key must roll back together.
  await runner.startTransaction();
  try {
    await runner.manager.insert(Entry, { id: marker, value: 99 });
    await runner.manager.insert(Entry, { id, value: 100 });
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    code = error?.driverError?.code;
    if (code !== '23505') throw error;
  }
  if (code === undefined) throw new Error('The duplicate insert unexpectedly committed');
  // The same actor connection keeps working after ROLLBACK.
  const committed = (await runner.manager.findOneByOrFail(Entry, { id })).value;
  const markerRows = await runner.manager.countBy(Entry, { id: marker });
  const { affected: deleted } = await runner.manager.delete(Entry, { id });
  return { inserted, updated, code, committed, markerRows, deleted };
}

const SERIALIZATION_FAILURE = '40001', ATTEMPT_LIMIT = 3;

// A retry restarts the whole transaction: a new snapshot, a fresh read and a
// new marker. Only the serialization failure SQLSTATE is retried.
async function serializable(runner, actor, retry) {
  const reads = [], errors = [];
  let rollbackVerified = false;
  for (let attempt = 1; ; attempt++) {
    await runner.startTransaction('SERIALIZABLE');
    try {
      await runner.manager.insert(Attempt, { actor, attempt });
      const before = await runner.manager.findOneByOrFail(Counter, { id: 1 });
      reads.push(before.value);
      await runner.manager.update(Counter, { id: 1 }, { value: before.value + 1 });
      await runner.commitTransaction();
      return { attempts: attempt, reads, errors, rollbackVerified };
    } catch (error) {
      await runner.rollbackTransaction();
      // The failed attempt's marker must be gone before anything else runs.
      assert.deepEqual(await runner.manager.findBy(Attempt, { actor }), [], 'A failed attempt must roll back its marker');
      rollbackVerified = true;
      const code = error?.driverError?.code;
      if (!retry || code !== SERIALIZATION_FAILURE || attempt === ATTEMPT_LIMIT) throw error;
      errors.push(code);
    }
  }
}

export function createTypeOrmScenario(behavior = 'lost-update') {
  if (!behaviors.includes(behavior)) throw new TypeError(`Unknown TypeORM behavior: ${behavior}`);
  const operation = context => withTypeOrmActor(context, entities, runner => {
    if (behavior === 'crud-rollback') return crudRollback(runner, context.actor);
    if (behavior.startsWith('serializable-')) return serializable(runner, context.actor, behavior === 'serializable-retry');
    return increment(runner, behavior === 'atomic');
  });
  return {
    name: `typeorm-${behavior}`,
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

export default createTypeOrmScenario();
