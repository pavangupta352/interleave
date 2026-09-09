import { Client } from 'pg';
import type { Scenario } from '../../../src/types.js';
// Deliberately omit pg's idle `error` listener, matching the review reproducer.
export default {
  name: 'supervised-idle-cancel', async setup() {},
  actors: {
    async alice({ connectionString }) {
      const client = new Client({ connectionString }); await client.connect();
      try { await client.query('SELECT 1'); await new Promise(resolve => setTimeout(resolve, 10_000)); }
      finally { await client.end(); }
    },
    async bob({ connectionString }) {
      const client = new Client({ connectionString }); await client.connect();
      try { await client.query('SELECT 2'); } finally { await client.end(); }
    },
  },
  async invariant() {},
} satisfies Scenario;
