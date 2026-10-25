import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { testDatabaseUrl } from './helpers/postgres.js';
import { npm } from './helpers/npm.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const databaseUrl = testDatabaseUrl();

// The installed-package workflow from examples/cursor/README.md: the folder is copied
// into an application as cursor/ and every command runs from the application root.
test('the cursor example behaves as its README states', { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave cursor example '));
  function execute(args: string[], cwd: string, expected: number) {
    const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8', timeout: 660_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl,
        npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
    expect(result.error).toBeUndefined();
    expect(result.status, (result.stderr || result.stdout || '').slice(-3000)).toBe(expected);
    return result.stdout;
  }
  try {
    const packed = JSON.parse(execute(npm('pack', '--ignore-scripts', '--json', '--pack-destination', root), repository, 0))[0];
    const app = join(root, 'bank'); await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'cursor-bank', private: true, type: 'module' }, null, 2) + '\n');
    execute(npm('install', '--save-dev', '--save-exact', join(root, packed.filename), 'pg@8.23.0', 'pg-cursor@2.22.1', '--ignore-scripts'), app, 0);
    await cp(join(repository, 'examples/cursor'), join(app, 'cursor'), { recursive: true, filter: source => !source.endsWith('README.md') });
    const cli = join(app, 'node_modules/@pavangupta352/interleave/dist/cli.js');
    const profiles = ['--protocol-profile', 'flush-stages-v1', '--connection-profile', 'multi-producer-v1'];

    // The default profiles refuse the job's second connection, then its Flush-dependent batches.
    const connections = JSON.parse(execute([process.execPath, cli, 'run', 'cursor/scenario.mjs', '--json'], app, 4));
    expect(connections.runs[0].outcome).toBe('inconclusive');
    expect(connections.runs[0].reason).toMatch(/multi-producer-v1/);
    const batches = JSON.parse(execute([process.execPath, cli, 'run', 'cursor/scenario.mjs', '--connection-profile', 'multi-producer-v1', '--json'], app, 4));
    expect(batches.runs[0].outcome).toBe('inconclusive');
    expect(batches.runs[0].reason).toMatch(/flush-stages-v1/);

    const artifact = join(root, 'cursor-failure.json');
    const found = JSON.parse(execute([process.execPath, cli, 'run', 'cursor/scenario.mjs', ...profiles, '--out', artifact, '--json'], app, 1));
    expect(found.violationCount).toBe(1);
    const recorded = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
    expect(recorded.schemaVersion).toBe(5);
    expect(recorded.limits).toMatchObject({ protocolProfile: 'flush-stages-v1', connectionProfile: 'multi-producer-v1' });
    expect(recorded.failure?.message).toMatch(/The deposit to account 3 was lost; its balance is 110.00/);
    expect(recorded.trace.some(step => step.stage === 'flush' && step.completion?.kind === 'flush' && step.completion.suspended)).toBe(true);
    const replayed = parseRunArtifact(JSON.parse(execute([process.execPath, cli, 'replay', 'cursor/scenario.mjs', artifact, '--json'], app, 1)));
    expect(replayed.failure?.fingerprint).toBe(recorded.failure?.fingerprint);
    const reduced = JSON.parse(execute([process.execPath, cli, 'minimize', 'cursor/scenario.mjs', artifact, '--json'], app, 1));
    expect(reduced.stopReason).toBe('locally-minimal');
    execute([process.execPath, cli, 'report', artifact, '--out', join(root, 'cursor.html')], app, 0);
    const safe = JSON.parse(execute([process.execPath, cli, 'run', 'cursor/safe-scenario.mjs', ...profiles, '--max-runs', '1000', '--total-timeout-ms', '600000', '--json'], app, 0));
    expect(safe.violationCount).toBe(0);
    expect(safe.stopReason).toBe('frontier-exhausted');
    console.log(JSON.stringify({ cursorExample: { attempts: found.metrics.completedRuns, plan: recorded.plan, steps: recorded.trace.length,
      reducedChoices: reduced.reducedChoices, originalChoices: reduced.originalChoices, safeRuns: safe.metrics.completedRuns } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
