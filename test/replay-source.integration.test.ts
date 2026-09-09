import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { runScenarioFile } from '../src/supervised.js';
import { replay } from '../src/replay.js';
import { parseRunArtifact } from '../src/artifact.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const databaseUrl = testDatabaseUrl();
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function application(extra = '', auxiliary = false) {
  await mkdir(join(repository, '.local'), { recursive: true });
  const root = await mkdtemp(join(repository, '.local/source-replay-')); temporary.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"source-replay-fixture","version":"1.0.0","type":"module"}');
  await writeFile(join(root, 'helper.mjs'), 'export const observation = 42;');
  await writeFile(join(root, 'input.json'), '{"value":1}');
  const entry = join(root, 'scenario.mjs');
  await writeFile(entry, `import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { observation } from './helper.mjs';
appendFileSync(new URL('./loaded.txt', import.meta.url), 'loaded\\n');
async function actor({ connectionString, actor }) {
  ${auxiliary ? 'const monitor = new Client({ connectionString }); await monitor.connect();' : ''}
  const db = new Client({ connectionString });
  await db.connect();
  try { await db.query('SELECT 1'); ${extra} return observation; }
  finally { await db.end(); ${auxiliary ? 'await monitor.end();' : ''} }
}
export default { name:'source-bound-replay', async setup(){}, actors:{alice:actor,bob:actor}, async invariant(){assert.fail('same invariant');} };`);
  return { root, entry, options: { databaseUrl, source: { projectRoot: root, include: ['input.json'] } } };
}
async function loads(root: string) { return (await readFile(join(root, 'loaded.txt'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length; }

test('file runs record selected source and actual dependencies before execution and preserve identity on replay', async () => {
  const f = await application();
  const first = await runScenarioFile(f.entry, f.options);
  expect(first.outcome).toBe('violation');
  expect(first.environment.source?.profile).toBe('node-source-v1');
  expect(first.environment.source?.components.source.files.some(file => file.path === 'input.json')).toBe(true);
  const second = await replay(f.entry, parseRunArtifact(JSON.stringify(first)), f.options);
  expect(second.outcome).toBe('violation');
  expect(second.environment.source?.fingerprint).toBe(first.environment.source?.fingerprint);
  expect(await loads(f.root)).toBe(2);
});

test('exact and guided replay inherit recorded source selections without repeating CLI options', async () => {
  const f = await application();
  const first = await runScenarioFile(f.entry, f.options);
  expect(first.outcome).toBe('violation');
  const second = await replay(f.entry, first, { databaseUrl });
  expect(second.outcome).toBe('violation');
  expect(second.environment.source?.fingerprint).toBe(first.environment.source?.fingerprint);
  await writeFile(join(f.root, 'input.json'), '{"value":2}');
  const guided = await replay(f.entry, first, { databaseUrl, mode: 'guided' });
  expect(guided.outcome).toBe('violation');
  expect(guided.environment.source?.includes).toEqual(['input.json']);
  expect(guided.environment.source?.fingerprint).not.toBe(first.environment.source?.fingerprint);
});

test.each(['helper.mjs', 'input.json', 'package.json'])('changed selected %s is incompatible before importing scenario code', async path => {
  const f = await application();
  const original = await runScenarioFile(f.entry, f.options);
  expect(original.outcome).toBe('violation');
  await writeFile(join(f.root, path), path === 'helper.mjs' ? 'export const observation = 43;' : path === 'input.json' ? '{"value":2}' : '{"name":"changed","version":"1.0.0","type":"module"}');
  const changed = await replay(f.entry, original, f.options);
  expect(changed.outcome).toBe('incompatible'); expect(changed.reason).toMatch(/source|dependenc|runtime/i);
  expect(changed.trace).toEqual([]); expect(changed.cleanup.complete).toBe(true);
  expect(await loads(f.root)).toBe(1);
});

test('known Node incompatibility is rejected by the parent before importing scenario code', async () => {
  const f = await application();
  const original = await runScenarioFile(f.entry, f.options);
  expect(original.outcome).toBe('violation');
  original.environment.nodeVersion = 'v99.0.0';
  const changed = await replay(f.entry, original, f.options);
  expect(changed.outcome).toBe('incompatible');
  expect(changed.reason).toMatch(/Node/i);
  expect(changed.trace).toEqual([]); expect(changed.cleanup.complete).toBe(true);
  expect(await loads(f.root)).toBe(1);
});

test('known PostgreSQL incompatibility is rejected by the parent before importing scenario code', async () => {
  const f = await application();
  const original = await runScenarioFile(f.entry, f.options);
  expect(original.outcome).toBe('violation');
  const currentMajor = /^(16|17|18)/.exec(original.environment.serverVersion)![1]!;
  const changedMajor = currentMajor === '16' ? '17' : currentMajor === '17' ? '18' : '16';
  original.environment.serverVersion = `${changedMajor}.0`;
  original.environment.fixture!.profile = `postgresql${changedMajor}-native-v1` as
    'postgresql16-native-v1' | 'postgresql17-native-v1' | 'postgresql18-native-v1';
  const changed = await replay(f.entry, original, f.options);
  expect(changed.outcome).toBe('incompatible');
  expect(changed.reason).toMatch(/PostgreSQL/i);
  expect(changed.trace).toEqual([]); expect(changed.cleanup.complete).toBe(true);
  expect(await loads(f.root)).toBe(1);
});

test('an explicit replay connection-profile mismatch is rejected before importing scenario code', async () => {
  const f = await application();
  const original = await runScenarioFile(f.entry, f.options);
  expect(original.outcome).toBe('violation');
  expect(original.limits.maxConnectionsPerActor).toBe(1);
  const changed = await replay(f.entry, original, { ...f.options, maxConnectionsPerActor: 2 });
  expect(changed.outcome).toBe('incompatible');
  expect(changed.reason).toMatch(/connection profile/i);
  expect(changed.trace).toEqual([]); expect(changed.cleanup.complete).toBe(true);
  expect(await loads(f.root)).toBe(1);
});

test('source drift during execution cannot produce a completed bound violation', async () => {
  const f = await application("if(actor === 'alice') writeFileSync(new URL('./helper.mjs', import.meta.url), 'export const observation = 99;');");
  const result = await runScenarioFile(f.entry, f.options);
  expect(result.outcome).toBe('inconclusive'); expect(result.reason).toMatch(/source|changed/i);
  expect(result.failure).toBeUndefined(); expect(result.cleanup.complete).toBe(true);
});

test('source drift preserves an already observed actor failure as a hard harness error', async () => {
  const f = await application(`if(actor === 'alice') {
    writeFileSync(new URL('./helper.mjs', import.meta.url), 'export const observation = 99;');
    throw new Error('KNOWN_ACTOR_FAILURE');
  }`);
  const result = await runScenarioFile(f.entry, f.options);
  expect(result.outcome).toBe('harness-error');
  expect(result.reason).toMatch(/application operations rejected/i);
  expect(result.reason).toMatch(/source|changed/i);
  expect(result.actors.some(actor => actor.status === 'rejected')).toBe(true);
  expect(result.failure).toBeUndefined(); expect(result.cleanup.complete).toBe(true);
  expect(parseRunArtifact(result)).toEqual(result);
});

test('legacy file evidence requires a new guided run before source-bound exact replay', async () => {
  const f = await application();
  const original = await runScenarioFile(f.entry, f.options);
  expect(original.outcome).toBe('violation');
  delete original.environment.source;
  const rejected = await replay(f.entry, original, f.options);
  expect(rejected.outcome).toBe('incompatible'); expect(await loads(f.root)).toBe(1);
  const guided = await replay(f.entry, original, { ...f.options, mode: 'guided' });
  expect(guided.outcome).toBe('violation'); expect(guided.environment.source).toBeDefined();
});

test('a source manifest that cannot fit the evidence limit stops before loading the scenario', async () => {
  const f = await application();
  const result = await runScenarioFile(f.entry, { ...f.options, maxEvidenceBytes: 1024 });
  expect(result.outcome).toBe('inconclusive'); expect(await loads(f.root)).toBe(0);
  expect(result.cleanup.complete).toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
});

test('supervised replay preserves the recorded auxiliary connection profile', async () => {
  const f = await application('', true);
  const first = await runScenarioFile(f.entry, { ...f.options, maxConnectionsPerActor: 2 });
  expect(first.outcome, first.reason).toBe('violation');
  expect(first.connections).toHaveLength(4);
  const second = await replay(f.entry, first, { databaseUrl });
  expect(second.outcome, second.reason).toBe('violation');
  expect(second.limits.maxConnectionsPerActor).toBe(2);
  expect(second.trace.map(step => step.connection)).toEqual([1, 1]);
});
