import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import type { Scenario } from '../../../src/types.js';

const directory = process.env.INTERLEAVE_MINIMIZE_PROBE_DIRECTORY!;
const actor: Scenario['actors'][string] = async ({ actor, connectionString }) => {
  await appendFile(join(directory, 'actors'), `${actor}\n`);
  const client = new Client({ connectionString }); await client.connect();
  try { return (await client.query('SELECT value FROM counter')).rows; }
  finally { await client.end(); }
};
const scenario: Scenario = {
  name: 'supervised-reduction-fixture-drift',
  async setup({ db, connectionString }) {
    let count = 0;
    try { count = Number(await readFile(join(directory, 'count'), 'utf8')); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    count++;
    await writeFile(join(directory, 'count'), String(count));
    await appendFile(join(directory, 'databases'), `${new URL(connectionString).pathname.slice(1)}\n`);
    await db.query('CREATE TABLE counter(value integer); INSERT INTO counter VALUES(1)');
    if (count >= 3) await db.query('UPDATE counter SET value=2');
  },
  actors: { alice: actor, bob: actor },
  async invariant() { assert.fail('same stable application assertion'); },
};
export default scenario;
