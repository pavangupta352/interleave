// Application operation: accept the caller's database client.
export async function incrementCounter(client, id) {
  const { rows } = await client.query('SELECT value FROM counters WHERE id = $1', [id]);
  const value = rows[0].value + 1;
  await client.query('UPDATE counters SET value = $1 WHERE id = $2', [value, id]);
  return value;
}
