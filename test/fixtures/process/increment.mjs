// A standalone program: it knows nothing about Interleave and reads its endpoint from the environment.
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows: [row] } = await client.query('SELECT value FROM counter WHERE id = 1');
  await client.query('UPDATE counter SET value = $1 WHERE id = 1', [row.value + 1]);
  process.stdout.write(JSON.stringify({ read: row.value, wrote: row.value + 1 }));
} finally { await client.end(); }
