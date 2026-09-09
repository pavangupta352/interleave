import assert from 'node:assert/strict';
import postgres from 'postgres';
import { runOnce } from '../../src/runner.ts';
import { replay } from '../../src/replay.ts';
import { parseRunArtifact } from '../../src/artifact-schema.ts';
import { createOwnedDatabase } from '../../src/database.ts';
import { createProxy } from '../../src/proxy.ts';

const prepare = process.argv[2] === 'true';
const options = { databaseUrl: process.env.TEST_DATABASE_URL, protocolProfile: 'describe-flush-v1' };
let value = 41;
const scenario = {
  name: 'real transaction shutdown',
  async setup({ db, connectionString }) {
    process.send({ owned: new URL(connectionString).pathname.slice(1) });
    await db.query('CREATE TABLE effects (id integer PRIMARY KEY, value integer)');
  },
  actors: {
    async writer({ connectionString, signal }) {
      const sql = postgres(connectionString, { max: 1, ssl: false, prepare, fetch_types: false });
      const abort = () => { void sql.end({ timeout: 0 }); };
      signal.addEventListener('abort', abort, { once: true });
      try { await sql.begin(async tx => { await tx`INSERT INTO effects VALUES (${1}, ${value})`; }); }
      finally { signal.removeEventListener('abort', abort); await sql.end({ timeout: 1 }); }
    },
    async idle() {},
  },
  async invariant() {},
};
const outcomes = [];
for (let repeat = 0; repeat < 3; repeat++) {
  value = 41;
  const recorded = await runOnce(scenario, options);
  assert.equal(recorded.outcome, 'passed', recorded.reason);
  value = 42;
  const changed = await replay(scenario, recorded, { databaseUrl: options.databaseUrl });
  assert.equal(changed.outcome, 'incompatible', changed.reason);
  assert.equal(changed.trace.at(-1).stage, 'describe');
  const limited = await runOnce(scenario, { ...options, maxSteps: 2 });
  assert.equal(limited.outcome, 'inconclusive', limited.reason);
  assert.equal(limited.trace.at(-1).stage, 'describe');
  for (const run of [recorded, changed, limited]) { assert.equal(run.cleanup.complete, true); parseRunArtifact(run); outcomes.push(run.outcome); }
}
// The protocol failure path must leave the same bounded driver cleanup window.
const database = await createOwnedDatabase(options.databaseUrl);
process.send({ owned: database.name });
const controller = new AbortController(), failures = [];
let sql, proxy;
try {
  await database.db.query('CREATE TABLE effects (value text)');
  proxy = await createProxy({ actor: 'writer', upstreamUrl: database.connectionString,
    protocolProfile: 'describe-flush-v1', maxBufferedBytes: 1024,
    onUnit(unit) { void unit.release().catch(error => failures.push(error.message)); },
    onError(error) { failures.push(error.message); controller.abort(); },
  });
  sql = postgres(proxy.connectionString, { max: 1, ssl: false, prepare, fetch_types: false });
  controller.signal.addEventListener('abort', () => { void sql.end({ timeout: 0 }); }, { once: true });
  await assert.rejects(sql.begin(async tx => { await tx`INSERT INTO effects VALUES (${'x'.repeat(8192)})`; }));
  assert.ok(failures.some(message => /buffered-byte limit/.test(message)), failures.join('; '));
  assert.deepEqual((await database.db.query('SELECT * FROM effects')).rows, []);
} finally { await proxy?.close(); await sql?.end({ timeout: 1 }); await database.close(); }
console.log(JSON.stringify({ prepare, outcomes, bufferedFailure: true }));
process.disconnect();
