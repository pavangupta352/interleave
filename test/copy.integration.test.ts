import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import postgres from 'postgres';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { afterEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { runOnce } from '../src/runner.js';
import { replay } from '../src/replay.js';
import type { ActorContext, RunResult, Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl = testDatabaseUrl();
const ownedNames = new Set<string>();
afterEach(async () => {
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  try {
    const leftovers = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [[...ownedNames]])).rows;
    for (const { datname } of leftovers) { assert.match(datname, /^interleave_[0-9a-f]{32}$/); await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`); }
    expect(leftovers).toEqual([]);
  } finally { ownedNames.clear(); await admin.end(); }
});

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const errorCode = (error: unknown): string => String((error as { code?: unknown }).code);
function checked(run: RunResult, outcome: RunResult['outcome'] = 'passed'): RunResult {
  expect(run.outcome, run.reason).toBe(outcome); expect(run.cleanup.complete).toBe(true);
  expect(parseRunArtifact(run)).toEqual(run); return run;
}
function scenario(name: string, actors: Scenario['actors'], invariant: Scenario['invariant'] = async () => {}): Scenario {
  return { name, actors, invariant, async setup({ db, connectionString }) {
    ownedNames.add(new URL(connectionString).pathname.slice(1));
    await db.query('CREATE TABLE items (id integer PRIMARY KEY, name text NOT NULL)');
  } };
}
async function withClient<T>({ connectionString, signal }: ActorContext, body: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString }); client.on('error', () => {});
  const abort = () => { void client.end().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  await client.connect();
  try { return await body(client); }
  finally { signal.removeEventListener('abort', abort); await client.end().catch(() => {}); }
}
async function copyIn(client: Client, sql: string, chunks: Iterable<string> | AsyncIterable<string>): Promise<void> {
  await pipeline(Readable.from(chunks), client.query(copyFrom(sql)));
}
async function copyOut(client: Client, sql: string, each?: (chunk: Buffer) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of client.query(copyTo(sql))) { chunks.push(chunk as Buffer); await each?.(chunk as Buffer); }
  return Buffer.concat(chunks);
}

describe('streaming COPY through actual drivers and real PostgreSQL', () => {
  test('pg-copy-streams copies in and out, records what moved, and replay rejects changed input', async () => {
    let rows = ['1\tapple\n', '2\tpear\n'];
    const run = scenario('copy in and out', {
      alice: context => withClient(context, async client => {
        await copyIn(client, 'COPY items (id, name) FROM STDIN', rows);
        return (await copyOut(client, 'COPY (SELECT id, name FROM items ORDER BY id) TO STDOUT')).toString();
      }),
      async bob() {},
    });
    const first = checked(await runOnce(run, { databaseUrl }));
    expect(first.schemaVersion).toBe(5);
    expect(first.limits.connectionProfile).toBe('single-producer-v1');
    expect(first.cancels).toBeUndefined();
    const data = '1\tapple\n2\tpear\n';
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toBe(data);
    expect(first.trace.map(step => step.sql)).toEqual(['COPY items (id, name) FROM STDIN', 'COPY (SELECT id, name FROM items ORDER BY id) TO STDOUT']);
    expect(first.trace[0]!.completion).toEqual({ transactionStatus: 'I', commandTags: ['COPY 2'], rowCount: 2, copy: [{ direction: 'in', bytes: 15, sha256: sha256(data) }] });
    expect(first.trace[1]!.completion).toEqual({ transactionStatus: 'I', commandTags: ['COPY 2'], rowCount: 2, copy: [{ direction: 'out', bytes: 15, sha256: sha256(data) }] });
    checked(await replay(run, first, { databaseUrl }));
    rows = ['1\tapple\n', '2\tplum\n'];
    const changed = checked(await replay(run, first, { databaseUrl }), 'incompatible');
    expect(changed.reason).toBe('Replay COPY data changed for alice at step 0');
  }, 60_000);

  test('Postgres.js writable() and readable() streams copy through the staged profile and replay', async () => {
    const run = scenario('postgres.js copy', {
      alice: async ({ connectionString, signal }) => {
        const sql = postgres(connectionString, { max: 1, ssl: false, fetch_types: false });
        const abort = () => { void sql.end({ timeout: 0 }); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          await pipeline(Readable.from(['1\tapple\n', '2\tpear\n']), await sql`COPY items (id, name) FROM STDIN`.writable());
          const chunks: Buffer[] = [];
          for await (const chunk of await sql`COPY (SELECT id, name FROM items ORDER BY id) TO STDOUT`.readable()) chunks.push(chunk as Buffer);
          return Buffer.concat(chunks).toString();
        } finally { signal.removeEventListener('abort', abort); await sql.end({ timeout: 1 }); }
      },
      async bob() {},
    });
    const first = checked(await runOnce(run, { databaseUrl, protocolProfile: 'describe-flush-v1' }));
    const data = '1\tapple\n2\tpear\n';
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toBe(data);
    expect(first.trace.map(step => step.completion?.kind !== 'metadata' ? step.completion?.copy : undefined)).toEqual([
      [{ direction: 'in', bytes: 15, sha256: sha256(data) }], [{ direction: 'out', bytes: 15, sha256: sha256(data) }],
    ]);
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);

  test('CopyFail from a destroyed stream ends the copy in PostgreSQL and leaves the session usable', async () => {
    const run = scenario('copy fail', {
      alice: context => withClient(context, async client => {
        const stream = client.query(copyFrom('COPY items (id, name) FROM STDIN'));
        const failed = new Promise<string>(resolve => stream.once('error', error => resolve(errorCode(error))));
        // The write callback runs once PostgreSQL has started the copy and the row was sent.
        await new Promise(resolve => stream.write('1\tapple\n', resolve));
        stream.destroy(new Error('stopped by the application'));
        const code = await failed;
        return { code, rows: (await client.query('SELECT count(*)::int AS rows FROM items')).rows[0].rows };
      }),
      async bob() {},
    });
    const first = checked(await runOnce(run, { databaseUrl }));
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toEqual({ code: '57014', rows: 0 });
    const copy = first.trace[0]!.completion;
    expect(copy).toMatchObject({ error: { code: '57014', message: 'COPY from stdin failed: stopped by the application' }, copy: [{ direction: 'in', bytes: 8, sha256: sha256('1\tapple\n') }] });
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);

  test('a large copy in and a slowly read copy out keep their exact bytes under backpressure', async () => {
    const lines = 200_000;
    const line = (index: number) => `${index}\t${'x'.repeat(90)}\n`;
    function* chunks(): Generator<string> { for (let start = 0; start < lines; start += 1_000) { let chunk = ''; for (let index = start; index < start + 1_000; index++) chunk += line(index); yield chunk; } }
    const expected = createHash('sha256'); let expectedBytes = 0;
    for (const chunk of chunks()) { expected.update(chunk); expectedBytes += Buffer.byteLength(chunk); }
    const digest = expected.digest('hex');
    const run = scenario('large copy', {
      alice: context => withClient(context, async client => {
        await copyIn(client, 'COPY items (id, name) FROM STDIN', chunks());
        let read = 0;
        const data = await copyOut(client, 'COPY (SELECT id, name FROM items ORDER BY id) TO STDOUT', async () => {
          // Read slowly so the actor socket fills and the proxy has to pause PostgreSQL.
          if (++read % 2_000 === 0) await new Promise(resolve => setTimeout(resolve, 5));
        });
        return { bytes: data.length, sha256: sha256(data) };
      }),
      async bob() {},
    });
    const first = checked(await runOnce(run, { databaseUrl, timeoutMs: 120_000 }));
    expect(expectedBytes).toBeGreaterThan(18_000_000);
    expect(first.actors.find(actor => actor.actor === 'alice')?.value).toEqual({ bytes: expectedBytes, sha256: digest });
    expect(first.trace.map(step => step.completion?.kind !== 'metadata' ? step.completion?.copy : undefined)).toEqual([
      [{ direction: 'in', bytes: expectedBytes, sha256: digest }], [{ direction: 'out', bytes: expectedBytes, sha256: digest }],
    ]);
  }, 180_000);

  test('a copy that waits for another actor\'s uncommitted row is observed as a lock wait and replays', async () => {
    const copier = (row: string, finish: 'COMMIT' | 'ROLLBACK') => (context: ActorContext) => withClient(context, async client => {
      await client.query('BEGIN');
      try { await copyIn(client, 'COPY items (id, name) FROM STDIN', [row]); return 'copied'; }
      catch (error) { return errorCode(error); }
      finally { await client.query(finish); }
    });
    const run = scenario('copy conflict', { alice: copier('1\tapple\n', 'COMMIT'), bob: copier('1\tpear\n', 'ROLLBACK') }, async ({ db }) => {
      assert.deepEqual((await db.query('SELECT id, name FROM items')).rows, [{ id: 1, name: 'apple' }]);
    });
    const first = checked(await runOnce(run, { databaseUrl, plan: ['alice', 'bob', 'alice', 'bob', 'alice', 'bob'] }));
    expect(first.actors.map(actor => actor.value)).toEqual(['copied', '23505']);
    expect(first.trace.map(step => `${step.actor}:${step.sql.split(' ')[0]}`)).toEqual(['alice:BEGIN', 'bob:BEGIN', 'alice:COPY', 'bob:COPY', 'alice:COMMIT', 'bob:ROLLBACK']);
    const waiting = first.trace[3]!;
    expect(waiting.waits.length).toBeGreaterThan(0);
    expect(waiting.waits[0]!.blockerPids).toEqual([first.trace[2]!.backendPid]);
    expect(waiting.completion).toMatchObject({ error: { code: '23505' }, copy: [{ direction: 'in', bytes: 7, sha256: sha256('1\tpear\n') }] });
    checked(await replay(run, first, { databaseUrl }));
  }, 60_000);
});
