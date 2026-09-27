// Sequelize findCreateFind inside PostgreSQL transactions (sequelize/sequelize#13482).
//
// Two requests claim the same unique key. Each runs Sequelize's public
// `Model.findCreateFind` inside its own managed transaction, as an application
// would when the claim is part of a larger unit of work. This file is identical
// in before-fix/ and after-fix/; only the installed Sequelize version differs.
import assert from 'node:assert/strict';
import pg from 'pg';
// Sequelize 6 is CommonJS; its named exports are properties of the default export.
import sequelizePackage from 'sequelize';

const { DataTypes, Sequelize } = sequelizePackage;

export function defineClaim(sequelize) {
  return sequelize.define('Claim', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    claimKey: { type: DataTypes.STRING, allowNull: false, unique: true, field: 'claim_key' },
  }, { tableName: 'claims', timestamps: false });
}

/** The application operation: find or create the claim within a transaction. */
export async function claimWinner({ connectionString, signal }) {
  const sequelize = new Sequelize(connectionString, {
    dialect: 'postgres',
    dialectModule: pg,
    logging: false,
    pool: { max: 1, min: 0 },
  });
  const Claim = defineClaim(sequelize);
  const abort = () => { void sequelize.close().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const [claim, created] = await sequelize.transaction(transaction =>
      Claim.findCreateFind({ where: { claimKey: 'winner' }, transaction }));
    return { status: 'ok', created, claimId: claim === null ? null : claim.id };
  } catch (error) {
    // Report the application-visible failure. The managed transaction has
    // already been rolled back by Sequelize.
    return { status: 'error', error: error?.name ?? 'Error', code: error?.original?.code ?? null };
  } finally {
    signal?.removeEventListener('abort', abort);
    await sequelize.close().catch(() => undefined);
  }
}

export default {
  name: 'sequelize-find-create-find-in-transactions',
  async setup({ db }) {
    await db.query('CREATE TABLE claims (id serial PRIMARY KEY, claim_key varchar(255) NOT NULL UNIQUE)');
  },
  actors: { alice: claimWinner, bob: claimWinner },
  async invariant({ db, results }) {
    const values = results.map(result => result.value);
    assert.ok(values.every(value => value?.status === 'ok'), 'every findCreateFind call must return the claim');
    assert.equal(values.filter(value => value.created).length, 1, 'exactly one call must create the claim');
    assert.equal(new Set(values.map(value => value.claimId)).size, 1, 'both calls must return the same claim');
    const { rows } = await db.query("SELECT count(*)::integer AS count FROM claims WHERE claim_key = 'winner'");
    assert.equal(rows[0].count, 1, 'exactly one claim row must exist');
  },
};
