import assert from 'node:assert/strict';
import pg from 'pg';

/** One worker process: it tries to claim job 1 once. */
export function worker(claim) {
  return async ({ connectionString, actor }) => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      return { claimed: await claim(client, actor) };
    } finally {
      await client.end();
    }
  };
}

export async function invariant({ db }) {
  const { rows } = await db.query('SELECT worker FROM claims WHERE job_id = 1 ORDER BY worker');
  assert.equal(rows.length, 1, `Job 1 must have exactly one owner; claimed by ${rows.map(row => row.worker).join(' and ') || 'nobody'}`);
}
