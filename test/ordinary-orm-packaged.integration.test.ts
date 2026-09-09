import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { verifyRegressionExport } from '../src/export.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const databaseUrl = testDatabaseUrl();
const pins = { pg: '8.23.0', 'drizzle-orm': '0.45.2', kysely: '0.29.5' };
const runBudget = ['--timeout-ms', '30000'];

test('ordinary ORM failures survive installed exact replay, reduction and offline export with source drift rejection', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave installed ordinary ORM '));
  const namesFile = join(root, 'owned.txt'), importsFile = join(root, 'imported.txt');
  const evidence = process.env.INTERLEAVE_ORM_INSTALLED_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  let commandIndex = 0;
  function execute(command: string, args: string[], cwd: string, expected = 0) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl,
        INTERLEAVE_ORM_OWNED: namesFile, INTERLEAVE_ORM_IMPORTED: importsFile,
        npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
    if (evidence) {
      const base = join(evidence, String(++commandIndex).padStart(2, '0'));
      writeFileSync(base + '.json', JSON.stringify({ command, args, cwd, pid: result.pid, status: result.status, signal: result.signal,
        error: result.error?.message, expected }, null, 2) + '\n');
      writeFileSync(base + '.stdout', result.stdout ?? ''); writeFileSync(base + '.stderr', result.stderr ?? '');
    }
    let diagnostic = (result.stderr || result.stdout || '').slice(-3000);
    if (result.status !== expected) {
      try {
        const output = JSON.parse(result.stdout), run = output.run ?? output.firstFailure ?? output;
        if (typeof run.outcome === 'string') diagnostic = JSON.stringify({ command, args,
          expected, status: result.status, signal: result.signal, outcome: run.outcome, reason: run.reason,
          limits: run.limits, durationMs: run.durationMs, traceCount: run.trace?.length,
          cleanup: run.cleanup, stderr: result.stderr?.slice(-1000) }).slice(0,6000);
      } catch { /* Retain the bounded raw diagnostic for non-JSON command output. */ }
    }
    expect(result.error).toBeUndefined();
    expect(result.status, diagnostic).toBe(expected);
    return result.stdout;
  }
  try {
    const packed = JSON.parse(execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], repository))[0];
    const archive = join(root, packed.filename);
    const app = join(root, 'application'); await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'ordinary-orm-qualification', private: true, type: 'module', dependencies: pins }, null, 2) + '\n');
    execute('npm', ['install', archive, '--ignore-scripts'], app);
    const installed = join(app, 'node_modules/@pavangupta352/interleave');
    await cp(join(installed, 'dist/examples/orm'), join(app, 'orm'), { recursive: true });
    const cli = join(installed, 'dist/cli.js');
    const lock = await readFile(join(app, 'package-lock.json'));
    for (const orm of ['drizzle', 'kysely'] as const) {
      const entry = `scenario-${orm}.mjs`, artifact = join(root, `${orm}.json`);
      await writeFile(join(app, entry), `import { appendFile } from 'node:fs/promises';
import { createOrmScenario } from './orm/scenario.js';
await appendFile(process.env.INTERLEAVE_ORM_IMPORTED, '${orm}\\n');
const scenario = createOrmScenario('${orm}');
export default { ...scenario, async setup(context) {
  await appendFile(process.env.INTERLEAVE_ORM_OWNED, new URL(context.connectionString).pathname.slice(1) + '\\n');
  await scenario.setup(context);
} };
`);
      execute(process.execPath, [cli, 'run', entry, '--project-root', app, '--plan', 'alice,bob,alice,bob', '--max-runs', '1', ...runBudget, '--out', artifact, '--json'], app, 1);
      const first = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
      expect(first.outcome, first.reason).toBe('violation'); expect(first.cleanup.complete).toBe(true);
      for (const [name, version] of Object.entries(pins)) expect(first.environment.source!.components.dependencies.packages.some(pkg => pkg.name === name && pkg.version === version && pkg.files.length > 0)).toBe(true);
      const repeated = parseRunArtifact(JSON.parse(execute(process.execPath, [cli, 'replay', entry, artifact, ...runBudget, '--json'], app, 1)));
      expect(repeated.failure).toEqual(first.failure); expect(repeated.actors).toEqual(first.actors);
      expect(repeated.environment.source).toEqual(first.environment.source); expect(repeated.cleanup.complete).toBe(true);
      const reduced = JSON.parse(execute(process.execPath, [cli, 'minimize', entry, artifact, ...runBudget, '--max-attempts', '12', '--out', join(root, `${orm}-minimal.json`), '--json'], app, 1));
      expect(reduced.run.failure).toEqual(first.failure); expect(reduced.run.trace).toHaveLength(4);
      expect(reduced.reducedChoices).toBeLessThan(reduced.originalChoices);
      expect(reduced.stopReason).toBe('locally-minimal'); expect(reduced.run.cleanup.complete).toBe(true);

      const source = join(app, 'orm', `${orm}.js`), sourceBytes = await readFile(source);
      const imported = await readFile(importsFile), namesBefore = await readFile(namesFile);
      try {
        await writeFile(source, Buffer.concat([sourceBytes, Buffer.from('\n// Changed application module for source identity qualification.\n')]));
        const drift = parseRunArtifact(JSON.parse(execute(process.execPath, [cli, 'replay', entry, artifact, ...runBudget, '--json'], app, 3)));
        expect(drift.outcome).toBe('incompatible'); expect(drift.reason).toMatch(/source/i);
        expect(drift.trace).toEqual([]); expect(drift.cleanup.complete).toBe(true);
        expect(await readFile(importsFile)).toEqual(imported); expect(await readFile(namesFile)).toEqual(namesBefore);
      } finally { await writeFile(source, sourceBytes); }

      const destination = join(root, `${orm} portable regression`);
      const exported = JSON.parse(execute(process.execPath, [cli, 'export', entry, artifact, '--project-root', app, '--runtime-archive', archive, '--out', destination, '--json'], app));
      const manifest = await verifyRegressionExport(destination);
      if (evidence) await writeFile(join(evidence, `${orm}-manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
      expect(manifest.installation?.layout).toBe('shared-app');
      expect(await readFile(join(destination, 'run.json'))).toEqual(await readFile(artifact));
      const installation = execute(process.execPath, ['install.mjs', '--offline'], destination);
      expect(installation).toContain('complete installed identity match');
      const [command, ...args] = exported.replay.command;
      const portable = parseRunArtifact(JSON.parse(execute(command, [...args, ...runBudget, '--json'], destination, 1)));
      expect(portable.outcome).toBe('violation'); expect(portable.failure).toEqual(first.failure);
      expect(portable.environment.source).toEqual(first.environment.source);
      expect(portable.environment.fixture).toEqual(first.environment.fixture);
      expect(portable.trace.map(step => step.fingerprint)).toEqual(first.trace.map(step => step.fingerprint));
      expect(portable.actors).toEqual(first.actors); expect(portable.cleanup.complete).toBe(true);
      expect(await readFile(join(app, 'package-lock.json'))).toEqual(lock);
      console.log(JSON.stringify({ installedOrdinaryOrm: { orm, node: first.environment.nodeVersion, server: first.environment.serverVersion,
        failure: first.failure?.fingerprint, source: first.environment.source?.fingerprint, exactReplay: true, offlineReplay: true } }));
    }
  } finally {
    const names = await readFile(namesFile, 'utf8').then(value => value.trim().split('\n'), error => { if (error.code === 'ENOENT') return []; throw error; });
    const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
    try {
      const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names])).rows;
      if (evidence) await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ names, remaining }, null, 2) + '\n');
      console.log(JSON.stringify({ installedOrmCleanup: { names, remaining } })); expect(remaining).toEqual([]);
    } finally { await admin.end(); await rm(root, { recursive: true, force: true }); }
  }
}, 240_000);
