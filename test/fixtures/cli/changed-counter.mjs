import scenario from './counter.mjs';
import { Client } from 'pg';
scenario.actors.alice = async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try { await client.query('UPDATE counter SET value = value + 1'); } finally { await client.end(); }
};
export default scenario;
