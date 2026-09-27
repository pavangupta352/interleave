import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const databaseUrl = testDatabaseUrl();
const python = process.env.INTERLEAVE_TEST_PYTHON!;

// Installed-package workflow from examples/python/README.md: the example folder is
// copied into an application as python/ and every command runs from the root.
// Python programs using psycopg are the actors; Interleave schedules their real
// PostgreSQL commands through each actor's loopback endpoint.
test('Python psycopg actors oversell, replay exactly, reject changed source and pass when repaired', { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave python actors '));
  function execute(args: string[], cwd: string, expected: number) {
    const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8', timeout: 660_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl, INTERLEAVE_PYTHON: python,
        npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
    expect(result.error).toBeUndefined();
    expect(result.status, (result.stderr || result.stdout || '').slice(-3000)).toBe(expected);
    return result.stdout;
  }
  try {
    const packed = JSON.parse(execute(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', root], repository, 0))[0];
    const app = join(root, 'shop'); await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'python-shop', private: true, type: 'module' }, null, 2) + '\n');
    execute(['npm', 'install', join(root, packed.filename), '--ignore-scripts'], app, 0);
    await cp(join(repository, 'examples/python'), join(app, 'python'), { recursive: true, filter: source => !source.endsWith('README.md') });
    const cli = join(app, 'node_modules/@pavangupta352/interleave/dist/cli.js');
    const artifact = join(root, 'oversell.json');

    const found = JSON.parse(execute([process.execPath, cli, 'run', 'python/scenario.mjs', '--include', 'python/checkout.py', '--out', artifact, '--json'], app, 1));
    expect(found.violationCount).toBeGreaterThan(0);
    const recorded = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
    expect(recorded.outcome).toBe('violation');
    expect(recorded.failure?.message).toMatch(/one unit of stock was sold 2 times/);
    expect(recorded.environment.source?.includes).toContain('python/checkout.py');
    expect(recorded.actors.map(actor => actor.value)).toEqual([{ saw_stock: 1, bought: true }, { saw_stock: 1, bought: true }]);
    expect(new Set(recorded.trace.map(step => step.actor))).toEqual(new Set(['alice', 'bob']));

    const repeated = parseRunArtifact(JSON.parse(execute([process.execPath, cli, 'replay', 'python/scenario.mjs', artifact, '--json'], app, 1)));
    expect(repeated.outcome).toBe('violation');
    expect(repeated.failure?.fingerprint).toBe(recorded.failure?.fingerprint);

    await appendFile(join(app, 'python/checkout.py'), '\n# edited after recording\n');
    const drift = parseRunArtifact(JSON.parse(execute([process.execPath, cli, 'replay', 'python/scenario.mjs', artifact, '--json'], app, 3)));
    expect(drift.outcome).toBe('incompatible');
    expect(drift.reason).toMatch(/source/i);

    // Every run starts two Python processes; the README gives the search ten minutes.
    const safe = JSON.parse(execute([process.execPath, cli, 'run', 'python/safe-scenario.mjs', '--include', 'python/checkout_safe.py', '--total-timeout-ms', '600000', '--json'], app, 0));
    expect(safe.violationCount).toBe(0);
    expect(safe.stopReason).toBe('frontier-exhausted');
    expect(safe.metrics.completedRuns).toBe(47);
  } finally { await rm(root, { recursive: true, force: true }); }
});
