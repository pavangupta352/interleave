import assert from 'node:assert/strict';
import { DataTypes, Transaction } from 'sequelize';
import { withSequelizeActor } from './connection.mjs';

const behaviors = ['lost-update', 'atomic', 'crud-rollback', 'serializable-retry', 'serializable-error'];

// Models map the tables created by setup; Sequelize's timestamp columns are off.
// define() annotates each attribute object, so every attribute gets its own.
function define(sequelize) {
  const integer = (extra = {}) => ({ type: DataTypes.INTEGER, allowNull: false, ...extra });
  const options = tableName => ({ tableName, timestamps: false });
  return {
    Counter: sequelize.define('Counter', { id: integer({ primaryKey: true }), value: integer() }, options('counter')),
    Entry: sequelize.define('Entry', { id: integer({ primaryKey: true }), value: integer() }, options('entries')),
    // One committed marker per actor records which transaction attempt committed.
    Attempt: sequelize.define('Attempt', { actor: { type: DataTypes.TEXT, primaryKey: true }, attempt: integer() }, options('attempts')),
  };
}

// Both behaviors read the counter first. The unsafe one saves the value it
// read plus one; the atomic one lets PostgreSQL add one to the current value
// and reads the result back from RETURNING.
async function increment({ Counter }, atomic) {
  const counter = await Counter.findByPk(1, { rejectOnEmpty: true });
  const read = counter.value;
  if (atomic) await counter.increment('value');
  else { counter.value = read + 1; await counter.save(); }
  return { read, written: counter.value };
}

async function crudRollback(sequelize, { Entry }, actor) {
  const id = actor === 'alice' ? 1 : 2, marker = id + 10;
  let inserted, updated, code;
  await sequelize.transaction(async transaction => {
    await Entry.create({ id, value: 1 }, { transaction });
    inserted = (await Entry.findByPk(id, { transaction, rejectOnEmpty: true })).value;
    await Entry.update({ value: 2 }, { where: { id }, transaction });
    updated = (await Entry.findByPk(id, { transaction, rejectOnEmpty: true })).value;
  });
  // A marker write followed by a duplicate primary key must roll back together.
  try {
    await sequelize.transaction(async transaction => {
      await Entry.create({ id: marker, value: 99 }, { transaction });
      await Entry.create({ id, value: 100 }, { transaction });
    });
  } catch (error) {
    code = error?.parent?.code;
    if (code !== '23505') throw error;
  }
  if (code === undefined) throw new Error('The duplicate insert unexpectedly committed');
  // The same actor connection keeps working after ROLLBACK.
  const committed = (await Entry.findByPk(id, { rejectOnEmpty: true })).value;
  const markerRows = await Entry.count({ where: { id: marker } });
  const deleted = await Entry.destroy({ where: { id } });
  return { inserted, updated, code, committed, markerRows, deleted };
}

const SERIALIZATION_FAILURE = '40001', ATTEMPT_LIMIT = 3;

// A retry restarts the whole transaction: a new snapshot, a fresh read and a
// new marker. Only the serialization failure SQLSTATE is retried.
async function serializable(sequelize, { Counter, Attempt }, actor, retry) {
  const reads = [], errors = [];
  let rollbackVerified = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, async transaction => {
        await Attempt.create({ actor, attempt }, { transaction });
        const counter = await Counter.findByPk(1, { transaction, rejectOnEmpty: true });
        reads.push(counter.value);
        counter.value += 1;
        await counter.save({ transaction });
      });
      return { attempts: attempt, reads, errors, rollbackVerified };
    } catch (error) {
      // The failed attempt's marker must be gone before anything else runs.
      assert.deepEqual(await Attempt.findAll({ where: { actor }, raw: true }), [], 'A failed attempt must roll back its marker');
      rollbackVerified = true;
      const code = error?.parent?.code;
      if (!retry || code !== SERIALIZATION_FAILURE || attempt === ATTEMPT_LIMIT) throw error;
      errors.push(code);
    }
  }
}

export function createSequelizeScenario(behavior = 'lost-update') {
  if (!behaviors.includes(behavior)) throw new TypeError(`Unknown Sequelize behavior: ${behavior}`);
  const operation = context => withSequelizeActor(context, sequelize => {
    const models = define(sequelize);
    if (behavior === 'crud-rollback') return crudRollback(sequelize, models, context.actor);
    if (behavior.startsWith('serializable-')) return serializable(sequelize, models, context.actor, behavior === 'serializable-retry');
    return increment(models, behavior === 'atomic');
  });
  return {
    name: `sequelize-${behavior}`,
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

export default createSequelizeScenario();
