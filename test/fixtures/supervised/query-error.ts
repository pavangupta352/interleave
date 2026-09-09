import { Client } from 'pg';
import type { Scenario } from '../../../src/types.js';
const query: Scenario['actors'][string] = async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try { await client.query('SELECT * FROM missing_supervised_table'); }
  finally { await client.end(); }
};
export default {
  name: 'supervised-query-error', async setup() {}, actors: { alice: query, bob: query }, async invariant() {},
} satisfies Scenario;
