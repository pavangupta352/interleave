// Knex migration lock initialization (knex/knex#4694).
//
// Both actors call Knex's public `knex.migrate.list()`. Before listing, Knex
// makes sure its migration tables exist and that the lock table holds one row.
// This file is identical in before-fix/ and after-fix/; only the installed Knex
// version differs.
import assert from 'node:assert/strict';
import knexFactory from 'knex';
// Knex loads its PostgreSQL driver dynamically. This import declares the
// installed driver as a source input; it does not replace or wrap the driver.
import 'pg';

// A documented custom migration source with no migrations, so listing needs no
// migration files and runs no migration code.
const migrationSource = {
  async getMigrations() { return []; },
  getMigrationName(name) { return name; },
  getMigration() { throw new Error('This scenario has no migration files'); },
};

export function connect(connectionString) {
  return knexFactory({
    client: 'pg',
    connection: connectionString,
    pool: { min: 0, max: 1 },
    migrations: { migrationSource, tableName: 'knex_migrations', schemaName: 'public' },
  });
}

/** The application operation: Knex's public migration status listing. */
export async function listMigrations({ connectionString }) {
  const knex = connect(connectionString);
  try {
    const [completed, pending] = await knex.migrate.list();
    return { completed: completed.length, pending: pending.length };
  } finally {
    await knex.destroy();
  }
}

export default {
  name: 'knex-migration-lock-initialization',
  async setup({ db, connectionString }) {
    // Create both migration tables through the same public call, then remove
    // the lock row. This is the state after the tables exist and before the
    // first lock row is inserted.
    await listMigrations({ connectionString });
    await db.query('DELETE FROM knex_migrations_lock');
  },
  actors: { alice: listMigrations, bob: listMigrations },
  async invariant({ db }) {
    const { rows } = await db.query('SELECT index, is_locked FROM knex_migrations_lock ORDER BY index');
    assert.equal(rows.length, 1, 'knex_migrations_lock must contain exactly one row');
    assert.equal(rows[0].is_locked, 0, 'the migration lock row must be unlocked');
    const completed = await db.query('SELECT count(*)::integer AS count FROM knex_migrations');
    assert.equal(completed.rows[0].count, 0, 'no migration may be recorded');
  },
};
