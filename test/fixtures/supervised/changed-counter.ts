import { Client } from 'pg';
import scenario from './counter.js';
scenario.actors.alice = async ({ connectionString }) => {
  const client = new Client({ connectionString }); await client.connect();
  try { await client.query('SELECT 42'); } finally { await client.end(); }
};
export default scenario;
