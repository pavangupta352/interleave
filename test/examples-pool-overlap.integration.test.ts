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

// Installed-package workflows from examples/pool/README.md and examples/overlap/README.md:
// each folder is copied into an application and every command runs from its root.
test('the pool and overlap examples behave as their READMEs state', { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave examples '));
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
    const app = join(root, 'shop'); await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'examples-shop', private: true, type: 'module' }, null, 2) + '\n');
    execute(npm('install', '--save-dev', '--save-exact', join(root, packed.filename), 'pg@8.23.0', '--ignore-scripts'), app, 0);
    for (const name of ['pool', 'overlap']) await cp(join(repository, 'examples', name), join(app, name), { recursive: true, filter: source => !source.endsWith('README.md') });
    const cli = join(app, 'node_modules/@pavangupta352/interleave/dist/cli.js');
    const multi = ['--connection-profile', 'multi-producer-v1'];

    // Pool: the default profile refuses the handler's second connection.
    const refused = JSON.parse(execute([process.execPath, cli, 'run', 'pool/scenario.mjs', '--json'], app, 4));
    console.log(JSON.stringify({ poolDefaultProfile: { stopReason: refused.stopReason, outcome: refused.runs[0]?.outcome, reason: refused.runs[0]?.reason } }));
    expect(refused.firstFailure).toBeUndefined();
    expect(refused.runs[0].outcome).toBe('inconclusive');
    expect(refused.runs[0].reason).toMatch(/multi-producer-v1/);
    const poolArtifact = join(root, 'pool-failure.json');
    const found = JSON.parse(execute([process.execPath, cli, 'run', 'pool/scenario.mjs', ...multi, '--out', poolArtifact, '--json'], app, 1));
    expect(found.violationCount).toBe(1);
    const recorded = parseRunArtifact(JSON.parse(await readFile(poolArtifact, 'utf8')));
    expect(recorded.limits.connectionProfile).toBe('multi-producer-v1');
    expect(recorded.failure?.message).toMatch(/Every pooled increment must be retained/);
    expect(new Set(recorded.trace.map(step => `${step.actor}#${step.connection}`)).size).toBe(4);
    // As the README says, a pool can route a later query differently; replay then
    // reports incompatible (exit 3) for that reason, and a rerun repeats the failure.
    let replayed: ReturnType<typeof parseRunArtifact> | undefined;
    for (let attempt = 0; attempt < 3 && replayed?.outcome !== 'violation'; attempt++) {
      const result = spawnSync(process.execPath, [cli, 'replay', 'pool/scenario.mjs', poolArtifact, '--json'],
        { cwd: app, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl } });
      expect([1, 3]).toContain(result.status);
      replayed = parseRunArtifact(JSON.parse(result.stdout));
      if (result.status === 3) expect(replayed.reason).toMatch(/identity changed/);
    }
    expect(replayed!.failure?.fingerprint).toBe(recorded.failure?.fingerprint);
    const reduced = JSON.parse(execute([process.execPath, cli, 'minimize', 'pool/scenario.mjs', poolArtifact, '--json'], app, 1));
    expect(reduced.stopReason).toBe('locally-minimal');
    execute([process.execPath, cli, 'report', poolArtifact, '--out', join(root, 'pool.html')], app, 0);
    const safePool = JSON.parse(execute([process.execPath, cli, 'run', 'pool/safe-scenario.mjs', ...multi, '--max-runs', '1000', '--total-timeout-ms', '600000', '--json'], app, 0));
    expect(safePool.violationCount).toBe(0);
    expect(safePool.stopReason).toBe('frontier-exhausted');
    console.log(JSON.stringify({ poolExample: { reducedChoices: reduced.reducedChoices, originalChoices: reduced.originalChoices, safeRuns: safePool.metrics.completedRuns } }));

    // Overlap: one statement at a time never fails; a released pair can.
    const sequential = JSON.parse(execute([process.execPath, cli, 'run', 'overlap/scenario.mjs', '--json'], app, 0));
    expect(sequential.violationCount).toBe(0);
    expect(sequential.stopReason).toBe('frontier-exhausted');
    const claimArtifact = join(root, 'claim-failure.json');
    // PostgreSQL decides how a released pair interleaves, and how often two claims overlap
    // depends on the host and server, so allow up to five searches and log how many it took.
    let paired: { violationCount: number } | undefined;
    let searches = 0;
    while (searches < 5 && !paired?.violationCount) {
      searches++;
      const result = spawnSync(process.execPath, [cli, 'run', 'overlap/scenario.mjs', '--overlap', 'pairs', '--out', claimArtifact, '--force', '--json'],
        { cwd: app, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl } });
      expect([0, 1]).toContain(result.status);
      paired = JSON.parse(result.stdout);
    }
    console.log(JSON.stringify({ overlapExample: { pairedSearches: searches } }));
    expect(paired!.violationCount).toBe(1);
    const claim = parseRunArtifact(JSON.parse(await readFile(claimArtifact, 'utf8')));
    expect(claim.plan).toContain('alice+bob');
    expect(claim.failure?.message).toMatch(/Job 1 must have exactly one owner/);
    const safeClaims = JSON.parse(execute([process.execPath, cli, 'run', 'overlap/safe-scenario.mjs', '--overlap', 'pairs', '--json'], app, 0));
    expect(safeClaims.violationCount).toBe(0);
    expect(safeClaims.stopReason).toBe('frontier-exhausted');
  } finally { await rm(root, { recursive: true, force: true }); }
});
