import { Client } from 'pg';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import type { RunResult, Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const lifecycle = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('../src/database.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/database.js')>();
  return { ...actual, async createOwnedDatabase(url: string) {
    const owned = await actual.createOwnedDatabase(url);
    lifecycle.names.push(owned.name);
    return owned;
  } };
});
import { runOnce } from '../src/runner.js';
import { runScenarioFile } from '../src/supervised.js';
import { replay } from '../src/replay.js';

const databaseUrl = testDatabaseUrl();
const roots: string[] = [];
afterEach(async () => {
  const names = lifecycle.names.splice(0);
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const remaining = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names]);
    expect(remaining.rows).toEqual([]);
    console.log(JSON.stringify({ exactReadiness: { ownedDatabases: names, remaining: remaining.rows } }));
  } finally { await admin.end(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); }
});

function omitIdentity(original: RunResult, identity: 'fixture' | 'connections'): RunResult {
  const legacy = structuredClone(original);
  if (identity === 'fixture') delete legacy.environment.fixture;
  else delete legacy.connections;
  // Schema 1 legacy readability is deliberately retained.
  return parseRunArtifact(legacy);
}

test.each(['fixture', 'connections'] as const)('direct exact replay without %s is incompatible before creating a database; guided remains allowed', async identity => {
  let setupCalls = 0;
  const scenario: Scenario = {
    name: 'direct-exact-readiness',
    async setup({ db }) { setupCalls++; await db.query('SELECT 1'); },
    actors: { async a() {}, async b() {} }, async invariant() {},
  };
  const original = await runOnce(scenario, { databaseUrl });
  expect(original.outcome).toBe('passed');
  const legacy = omitIdentity(original, identity);
  const before = lifecycle.names.length;
  const exact = await runOnce(scenario, { databaseUrl, replay: legacy });
  expect(exact.outcome).toBe('incompatible');
  expect(exact.reason).toMatch(new RegExp(identity === 'fixture' ? 'fixture identity' : 'connection identities'));
  expect(exact.cleanup.complete).toBe(true);
  expect(setupCalls).toBe(1);
  expect(lifecycle.names).toHaveLength(before);
  expect(parseRunArtifact(exact)).toEqual(exact);
  const guided = await replay(scenario, legacy, { databaseUrl, mode: 'guided' });
  expect(guided.outcome).toBe('passed');
  expect(guided.mode).toBe('guided');
  expect(setupCalls).toBe(2);
});

test.each(['fixture', 'connections'] as const)('file exact replay without %s is incompatible before database creation or import; guided remains allowed', async identity => {
  const local = fileURLToPath(new URL('../.local/', import.meta.url));
  await mkdir(local, { recursive: true });
  const root = await mkdtemp(join(local, 'exact-readiness-')); roots.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"exact-readiness-fixture","version":"1.0.0","type":"module"}');
  const file = join(root, 'scenario.mjs');
  await writeFile(file, `import { appendFileSync } from 'node:fs';
appendFileSync(new URL('./imports.txt', import.meta.url), 'imported\\n');
export default { name:'file-exact-readiness', async setup({db}) { await db.query('SELECT 1'); },
actors:{async a(){},async b(){}},async invariant(){} };`);
  const options = { databaseUrl, source: { projectRoot: root } };
  const original = await runScenarioFile(file, options);
  expect(original.outcome, original.reason).toBe('passed');
  const legacy = omitIdentity(original, identity);
  const before = lifecycle.names.length;
  const exact = await runScenarioFile(file, { ...options, replay: legacy });
  expect(exact.outcome).toBe('incompatible');
  expect(exact.reason).toMatch(new RegExp(identity === 'fixture' ? 'fixture identity' : 'connection identities'));
  expect(exact.cleanup.complete).toBe(true);
  expect(await readFile(join(root, 'imports.txt'), 'utf8')).toBe('imported\n');
  expect(lifecycle.names).toHaveLength(before);
  expect(parseRunArtifact(exact)).toEqual(exact);
  const guided = await replay(file, legacy, { ...options, mode: 'guided' });
  expect(guided.outcome, guided.reason).toBe('passed');
  expect(guided.mode).toBe('guided');
  expect(await readFile(join(root, 'imports.txt'), 'utf8')).toBe('imported\nimported\n');
});
