import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const databaseUrl = testDatabaseUrl();
function execute(command: string, args: string[], cwd: string, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout.slice(-1000)).toBe(expected); return result.stdout;
}

test('the installed package ships a runnable pghybrid scenario with source-bound CLI replay', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave packaged pghybrid '));
  try {
    const packed = JSON.parse(execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], repository))[0];
    const app = join(root, 'app'); await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'pghybrid-packaged-qualification', private: true, type: 'module', dependencies: { pg: '8.23.0' } }, null, 2) + '\n');
    execute('npm', ['install', join(root, packed.filename), '--ignore-scripts'], app);
    const installed = join(app, 'node_modules/@pavangupta352/interleave');
    await cp(join(installed, 'dist/examples/pghybrid/scenario.js'), join(app, 'scenario.mjs'));
    await cp(join(installed, 'dist/examples/pghybrid/vendor'), join(app, 'vendor'), { recursive: true });
    const originalLicense = await readFile(join(repository, 'examples/pghybrid/vendor/LICENSE'));
    expect(await readFile(join(app, 'vendor/LICENSE'))).toEqual(originalLicense);
    const cli = join(installed, 'dist/cli.js'), artifact = join(root, 'record.json');
    const search = JSON.parse(execute(process.execPath, [cli, 'run', 'scenario.mjs', '--project-root', app, '--include', 'vendor',
      '--fixture-profile', 'postgresql17-pgvector0.8.6-v1', '--plan', 'first,second', '--max-runs', '1', '--timeout-ms', '30000', '--out', artifact, '--json'], app, 4));
    expect(search.stopReason).toBe('max-runs'); expect(search.explored).toBe(1);
    const recorded = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
    expect(recorded.outcome).toBe('passed'); expect(recorded.cleanup.complete).toBe(true);
    expect(recorded.environment.source?.components.runtime.mode).toBe('build');
    expect(recorded.environment.source?.components.source.files.some(file => file.path === 'vendor/LICENSE')).toBe(true);
    expect(recorded.environment.fixture?.profile).toBe('postgresql17-pgvector0.8.6-v1');
    expect(recorded.trace.map(step => step.actor)).toEqual(['first', 'second']);
    expect(recorded.actors.map(actor => actor.value)).toEqual([
      ['Termination for convenience', 'Renewal pricing', 'Renewal terms'],
      ['Termination for convenience', 'Renewal pricing', 'Renewal terms'],
    ]);
    const repeated = parseRunArtifact(JSON.parse(execute(process.execPath, [cli, 'replay', 'scenario.mjs', artifact, '--json'], app)));
    expect(repeated.outcome).toBe('passed'); expect(repeated.cleanup.complete).toBe(true);
    expect(repeated.environment.source).toEqual(recorded.environment.source);
    expect(repeated.environment.fixture).toEqual(recorded.environment.fixture);
    expect(repeated.trace.map(step => step.fingerprint)).toEqual(recorded.trace.map(step => step.fingerprint));
    expect(repeated.actors).toEqual(recorded.actors);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 90_000);
