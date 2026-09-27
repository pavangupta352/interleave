/** Unsafe: reads the counter, then writes the incremented value in a separate statement. */
export async function addOne(pool) {
  const { rows } = await pool.query('SELECT value FROM counters WHERE id = 1');
  await pool.query('UPDATE counters SET value = $1 WHERE id = 1', [rows[0].value + 1]);
}

/** Safe: one atomic update. */
export async function addOneAtomically(pool) {
  await pool.query('UPDATE counters SET value = value + 1 WHERE id = 1');
}
