// node-pg-migrate migrations-table bootstrap (salsita/node-pg-migrate#821, fixed by #830).
//
// Both actors call the public programmatic runner with an empty migrations
// directory, as two application instances would at startup against a new
// database. This file is identical in before-fix/ and after-fix/; only the
// installed node-pg-migrate version differs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import nodePgMigrate from 'node-pg-migrate';

// The CommonJS package exports its runner as `default`.
const migrate = nodePgMigrate.default;
const migrationsDirectory = fileURLToPath(new URL('./migrations', import.meta.url));
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** The application operation: run pending migrations with an owned pg Client. */
export async function runMigrations({ connectionString, signal }) {
  const client = new pg.Client({ connectionString });
  const abort = () => { void client.end().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.connect();
    try {
      await migrate({
        dbClient: client,
        dir: migrationsDirectory,
        migrationsTable: 'pgmigrations',
        direction: 'up',
        count: Infinity,
        ignorePattern: '\\..*',
        checkOrder: true,
        logger: silentLogger,
      });
      return { outcome: 'completed' };
    } catch (error) {
      return { outcome: classify(error) };
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.end().catch(() => undefined);
  }
}

// The runner wraps database errors in a new Error whose message quotes the
// original error, so the outcomes are recognized by their text. A second
// CREATE TABLE that starts after the first has committed reports 42P07. One
// that overlaps the first waits for it and then reports a unique violation on
// a system catalog index instead; both are the same duplicate creation.
function classify(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Another migration is already running')) return 'busy';
  if (message.includes('relation "pgmigrations" already exists')) return 'duplicate-table';
  if (/violates unique constraint "pg_(?:class_relname|type_typname)_nsp_index"/.test(message)) return 'duplicate-table-catalog-entry';
  return 'unexpected-error';
}

export default {
  name: 'node-pg-migrate-migrations-table-bootstrap',
  async setup() {
    // A new, empty database: no migrations table exists yet.
  },
  actors: { first: runMigrations, second: runMigrations },
  async invariant({ db, results }) {
    const outcomes = results.map(result => result.value?.outcome);
    assert.ok(outcomes.includes('completed'), 'at least one migration runner must complete');
    assert.ok(outcomes.every(outcome => outcome === 'completed' || outcome === 'busy'),
      'each concurrent runner must complete or report the documented busy lock');
    const table = await db.query("SELECT to_regclass('public.pgmigrations')::text AS name");
    assert.equal(table.rows[0].name, 'pgmigrations', 'the runner must create its migrations table');
    const journal = await db.query('SELECT count(*)::integer AS count FROM public.pgmigrations');
    assert.equal(journal.rows[0].count, 0, 'the empty migrations directory must leave the journal empty');
  },
};
