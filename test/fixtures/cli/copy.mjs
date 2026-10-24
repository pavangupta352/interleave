import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';

export default {
  name: 'cli-copy',
  async setup({ db }) { await db.query('CREATE TABLE items (id integer PRIMARY KEY, name text NOT NULL)'); },
  actors: {
    async alice({ connectionString }) {
      const client = new pg.Client({ connectionString }); await client.connect();
      try {
        await pipeline(Readable.from(['1\tapple\n', '2\tpear\n']), client.query(copyFrom('COPY items (id, name) FROM STDIN')));
        const chunks = [];
        for await (const chunk of client.query(copyTo('COPY (SELECT id, name FROM items ORDER BY id) TO STDOUT'))) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
      } finally { await client.end(); }
    },
    async bob({ connectionString }) {
      const client = new pg.Client({ connectionString }); await client.connect();
      try { return (await client.query('SELECT 1 AS one')).rows[0].one; } finally { await client.end(); }
    },
  },
  async invariant({ db }) { assert.equal((await db.query('SELECT count(*)::int AS rows FROM items')).rows[0].rows, 2); },
};
