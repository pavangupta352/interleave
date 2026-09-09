import { Client } from 'pg';
import type { Scenario } from '../../../src/types.js';
const literal = 'postgresql://report-reader@example.invalid/reporting';
const query: Scenario['actors'][string] = async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try {
    const result = await client.query(`SELECT '${literal}'::text AS selected`);
    return { connectionString, selected: result.rows[0].selected };
  } finally { await client.end(); }
};
export default {
  name: 'supervised-private-evidence',
  async setup({ connectionString }) {
    console.log('SUPERVISED_UNRECORDED_LOG_SENTINEL', connectionString);
    console.error('SUPERVISED_UNRECORDED_LOG_SENTINEL', connectionString);
  },
  actors: { alice: query, bob: query },
  async invariant() {},
} satisfies Scenario;
