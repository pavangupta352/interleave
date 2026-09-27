import assert from 'node:assert/strict';
import { Client } from 'pg';
// One statement claims the lock unless a claim exists; the pause keeps it open after its snapshot.
const claim = holder => async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try {
    await client.query(`INSERT INTO claim (holder) SELECT '${holder}' FROM (SELECT pg_sleep(0.2)) AS pause WHERE NOT EXISTS (SELECT 1 FROM claim)`);
  } finally { await client.end(); }
};
export default {
  name: 'cli-claim',
  async setup({ db }) { await db.query('CREATE TABLE claim (holder text NOT NULL)'); },
  actors: { alice: claim('alice'), bob: claim('bob') },
  async invariant({ db }) { assert.equal((await db.query('SELECT count(*)::int AS claims FROM claim')).rows[0].claims, 1, 'Exactly one claim'); },
};
