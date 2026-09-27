// Supplementary scenario for Knex 0.95.12 only. It reuses the main scenario
// and adds a third actor that is test scaffolding, not application code: it
// holds a lock on the lock table's sequence so that both conditional inserts
// wait at nextval() after their NOT EXISTS checks. The explicit plan in the
// README releases both inserts while the blocker holds that lock. This makes
// the overlap that ordinary concurrency produced repeatable under Interleave.
import pg from 'pg';
import scenario, { listMigrations } from './scenario.mjs';

async function holdSequenceLock({ connectionString }) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER SEQUENCE "public"."knex_migrations_lock_index_seq" INCREMENT BY 1');
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

export default {
  ...scenario,
  name: 'knex-migration-lock-conditional-insert-overlap',
  actors: { alice: listMigrations, bob: listMigrations, blocker: holdSequenceLock },
};
