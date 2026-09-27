/**
 * Unsafe: claims a job unless it is already claimed, in one statement. The check
 * and the insert share one snapshot, so two claims that run at the same moment can
 * both see no claim and both insert.
 */
export async function claim(client, worker) {
  const { rowCount } = await client.query(
    'INSERT INTO claims (job_id, worker) SELECT 1, $1 WHERE NOT EXISTS (SELECT 1 FROM claims WHERE job_id = 1)', [worker]);
  return rowCount === 1;
}

/** Safe: a unique job id lets PostgreSQL decide; the loser waits, then inserts nothing. */
export async function claimOnce(client, worker) {
  const { rowCount } = await client.query(
    'INSERT INTO claims (job_id, worker) VALUES (1, $1) ON CONFLICT (job_id) DO NOTHING', [worker]);
  return rowCount === 1;
}
