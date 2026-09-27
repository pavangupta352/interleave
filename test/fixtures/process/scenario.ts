import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { processActor } from '../../../src/process-actor.js';
import type { Scenario } from '../../../src/types.js';

const program = fileURLToPath(new URL('./increment.mjs', import.meta.url));
export default {
  name: 'process-counter',
  async setup({ db }) { await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1, 0)'); },
  actors: { alice: processActor(process.execPath, [program]), bob: processActor(process.execPath, [program]) },
  async invariant({ db }) { assert.equal((await db.query('SELECT value FROM counter')).rows[0].value, 2, 'both increments survive'); },
} satisfies Scenario;
