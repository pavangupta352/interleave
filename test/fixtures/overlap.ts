import assert from 'node:assert/strict';
import { Client } from 'pg';
import postgres from 'postgres';
import type { ActorContext, Scenario } from '../../src/types.js';
import { withPool } from './multi-producer.js';

/**
 * Claims a lock row unless one exists, in one statement. The pause holds the
 * statement open after its snapshot, so two claims that start together both see
 * an empty table. Released one at a time, the second always sees the first.
 */
export const claimSql = (holder: string): string =>
  `INSERT INTO claim (holder) SELECT '${holder}' FROM (SELECT pg_sleep(0.2)) AS pause WHERE NOT EXISTS (SELECT 1 FROM claim)`;

async function once<T>(context: ActorContext, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: context.connectionString });
  client.on('error', () => undefined);
  await client.connect();
  try { return await work(client); } finally { await client.end().catch(() => undefined); }
}

const claimSetup: Scenario['setup'] = async ({ db }) => { await db.query('CREATE TABLE claim (holder text NOT NULL)'); };
const oneClaim: Scenario['invariant'] = async ({ db }) => {
  const { rows } = await db.query('SELECT holder FROM claim ORDER BY holder');
  assert.equal(rows.length, 1, `Exactly one holder may claim the lock; found ${rows.map(row => row.holder).join(', ')}`);
};

/** Two actors each claim once: node-postgres simple queries, or Postgres.js prepared statements. */
export function statementRace(driver: 'pg' | 'postgres.js' = 'pg'): Scenario {
  const claim = (holder: string) => async (context: ActorContext): Promise<number | null> => {
    if (driver === 'pg') return once(context, async client => (await client.query(claimSql(holder))).rowCount);
    // Prepared statements send Parse/Describe/Flush before Bind/Execute/Sync.
    const sql = postgres(context.connectionString, { max: 1, fetch_types: false, onnotice: () => undefined });
    try {
      const result = await sql`INSERT INTO claim (holder) SELECT ${holder}::text FROM (SELECT pg_sleep(0.2)) AS pause WHERE NOT EXISTS (SELECT 1 FROM claim)`;
      return result.count;
    } finally { await sql.end({ timeout: 1 }); }
  };
  return { name: `statement-race-${driver === 'pg' ? 'pg' : 'postgresjs'}`, setup: claimSetup, actors: { alice: claim('alice'), bob: claim('bob') }, invariant: oneClaim };
}

/** One actor claims twice at once through a two-connection pool; bob only reads. */
export function pooledStatementRace(): Scenario {
  return {
    name: 'pooled-statement-race', setup: claimSetup,
    actors: {
      alice: context => withPool(context, pool => Promise.all([pool.query(claimSql('alice')), pool.query(claimSql('alice'))]).then(results => results.map(result => result.rowCount))),
      bob: context => once(context, async client => (await client.query('SELECT count(*)::int AS claims FROM claim')).rows[0].claims as number),
    },
    invariant: oneClaim,
  };
}

/** Atomic increments stay correct however PostgreSQL interleaves them. */
export function atomicIncrement(): Scenario {
  const increment = (context: ActorContext) => once(context, async client =>
    (await client.query('UPDATE counter SET value = value + 1 WHERE id = 1 AND pg_sleep(0.1) IS NOT NULL')).rowCount);
  return {
    name: 'atomic-increment',
    async setup({ db }) { await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1, 0)'); },
    actors: { alice: increment, bob: increment },
    async invariant({ db }) {
      assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 2, 'Both increments survive');
    },
  };
}
