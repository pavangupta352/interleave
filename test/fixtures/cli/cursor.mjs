import pg from 'pg';
import Cursor from 'pg-cursor';

export default {
  name: 'cli-cursor',
  async setup({ db }) { await db.query('CREATE TABLE items (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO items SELECT g, g FROM generate_series(1, 5) g'); },
  actors: {
    async alice({ connectionString }) {
      const client = new pg.Client({ connectionString }); await client.connect();
      try {
        const cursor = client.query(new Cursor('SELECT id, value FROM items ORDER BY id'));
        const values = [];
        for (let batch = await cursor.read(2); batch.length; batch = await cursor.read(2)) values.push(...batch.map(row => row.value));
        await cursor.close();
        return values;
      } finally { await client.end(); }
    },
    async bob({ connectionString }) {
      const client = new pg.Client({ connectionString }); await client.connect();
      try { await client.query('UPDATE items SET value = value + 10 WHERE id = 5'); } finally { await client.end(); }
    },
  },
  async invariant() {},
};
