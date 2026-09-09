import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { verifyRegressionExport } from '../src/export.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const databaseUrl = testDatabaseUrl();
function execute(args: string[], cwd: string, expected = 0, command = process.execPath, extra: Record<string, string> = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', ...extra } });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout.slice(-3000)).toBe(expected);
  return result.stdout;
}

test('installed Postgres.js records staged evidence, exports original bytes and replays after a fresh offline install', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave postgresjs export '));
  try {
    const archives = join(root, 'archives'); await mkdir(archives);
    const packed = JSON.parse(execute(['pack', '--ignore-scripts', '--json', '--pack-destination', archives], repository, 0, 'npm'))[0];
    const archive = join(archives, packed.filename);
    const app = join(root, 'app'); await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'postgresjs-qualification', private: true, type: 'module', dependencies: { postgres: '3.4.9' } }, null, 2) + '\n');
    await cp(join(repository, 'examples/postgresjs/scenario.mjs'), join(app, 'scenario.mjs'));
    await writeFile(join(app, 'entry.mjs'), "import { defineScenario } from '@pavangupta352/interleave';\nimport scenario from './scenario.mjs';\nexport default defineScenario(scenario);\n");
    execute(['install', archive, '--ignore-scripts'], app, 0, 'npm');
    const originals = new Map<string, Buffer>();
    for (const file of ['entry.mjs', 'scenario.mjs', 'package.json', 'package-lock.json']) originals.set(file, await readFile(join(app, file)));
    const cli = join(app, 'node_modules/@pavangupta352/interleave/dist/cli.js');
    const runFile = join(root, 'original.json');
    execute([cli, 'run', 'entry.mjs', '--protocol-profile', 'describe-flush-v1', '--max-runs', '1', '--timeout-ms', '20000', '--out', runFile, '--json'], app, 1);
    const recorded = parseRunArtifact(JSON.parse(await readFile(runFile, 'utf8')));
    expect(recorded.schemaVersion).toBe(2); expect(recorded.outcome).toBe('violation'); expect(recorded.cleanup.complete).toBe(true);
    expect(recorded.environment.source?.components.dependencies.packages.some(pkg => pkg.name === 'postgres' && pkg.version === '3.4.9')).toBe(true);
    expect(recorded.trace.map(step => step.stage)).toEqual(['describe', 'describe', 'execute', 'execute', 'describe', 'describe', 'execute', 'execute']);
    expect(recorded.trace.filter(step => step.stage === 'describe').every(step => step.completion?.kind === 'metadata')).toBe(true);
    expect(recorded.actors.map(actor => actor.value)).toEqual([{ read: 0, wrote: 1 }, { read: 0, wrote: 1 }]);
    // Noncanonical whitespace is deliberate: export must preserve the user's file.
    const originalBytes = Buffer.from('\n' + JSON.stringify(recorded, null, 4) + '\n\n'); await writeFile(runFile, originalBytes);
    const destination = join(root, 'portable');
    const exported = JSON.parse(execute([cli, 'export', 'entry.mjs', runFile, '--project-root', app, '--runtime-archive', archive, '--out', destination, '--json'], app));
    expect((await verifyRegressionExport(destination)).installation?.layout).toBe('shared-app');
    expect(await readFile(join(destination, 'run.json'))).toEqual(originalBytes);
    await rm(archives, { recursive: true });
    expect(execute(['install.mjs'], destination, 0, process.execPath, { npm_config_registry: 'https://unavailable.invalid/' })).toContain('complete installed identity match');
    const [command, ...args] = exported.replay.command;
    const repeated = parseRunArtifact(JSON.parse(execute([...args, '--json'], destination, 1, command)));
    expect(repeated.schemaVersion).toBe(2); expect(repeated.outcome).toBe('violation'); expect(repeated.cleanup.complete).toBe(true);
    expect(repeated.environment.source).toEqual(recorded.environment.source);
    expect(repeated.environment.fixture).toEqual(recorded.environment.fixture);
    expect(repeated.failure?.fingerprint).toBe(recorded.failure?.fingerprint);
    expect(repeated.trace.map(step => [step.stage, step.cycle, step.prefixOrdinal, step.fingerprint])).toEqual(recorded.trace.map(step => [step.stage, step.cycle, step.prefixOrdinal, step.fingerprint]));
    for (const [file, bytes] of originals) expect(await readFile(join(destination, 'app', file))).toEqual(bytes);
    expect(await readFile(join(destination, 'run.json'))).toEqual(originalBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
