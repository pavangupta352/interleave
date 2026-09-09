import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact-schema.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const databaseUrl = testDatabaseUrl();
const pins = { pg: '8.23.0', postgres: '3.4.9', 'drizzle-orm': '0.45.2', kysely: '0.29.5' };
const timeoutMs = 30_000;
const budget = ['--timeout-ms', String(timeoutMs)];

test('all four public adapters and the supplemental pg Client replay from a clean source-bound package installation', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'interleave installed pghybrid adapters '));
  const journal = join(root, 'owned.txt');
  const imports = join(root, 'imported.txt');
  function execute(command: string, args: string[], cwd: string, expected = 0) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl, PGHYBRID_OWNED_JOURNAL: journal,
        PGHYBRID_IMPORT_JOURNAL: imports,
        npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout.slice(-2000)).toBe(expected);
    return result.stdout;
  }
  try {
    const packed = JSON.parse(execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], repository))[0];
    const app = join(root, 'app'); await mkdir(app);
    // The aggregate example imports every caller at module load, so every row
    // deliberately installs/binds the complete optional dependency set.
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'pghybrid-adapter-installed-qualification', private: true,
      type: 'module', dependencies: pins }, null, 2) + '\n');
    execute('npm', ['install', join(root, packed.filename), '--ignore-scripts'], app);
    const installed = join(app, 'node_modules/@pavangupta352/interleave');
    for (const file of ['scenario.js', 'adapters.js']) await cp(join(installed, 'dist/examples/pghybrid', file), join(app, file));
    await cp(join(installed, 'dist/examples/pghybrid/vendor'), join(app, 'vendor'), { recursive: true });
    expect(await readFile(join(app, 'vendor/LICENSE'))).toEqual(await readFile(join(repository, 'examples/pghybrid/vendor/LICENSE')));
    const lock = await readFile(join(app, 'package-lock.json'));
    for (const [name, version] of Object.entries(pins)) expect(JSON.parse(await readFile(join(app, 'node_modules', name, 'package.json'), 'utf8')).version).toBe(version);
    const cli = join(installed, 'dist/cli.js');
    for (const adapter of ['pg-pool', 'pg-client', 'postgresjs', 'drizzle', 'kysely']) {
      const entry = `entry-${adapter}.mjs`, artifact = join(root, `${adapter}.json`);
      await writeFile(join(app, entry), `import { appendFile } from 'node:fs/promises';
import { createPghybridAdapterScenario } from './adapters.js';
await appendFile(process.env.PGHYBRID_IMPORT_JOURNAL, ${JSON.stringify(adapter)} + '\\n');
const original = createPghybridAdapterScenario(${JSON.stringify(adapter)});
export default { ...original, async setup(context) {
  await appendFile(process.env.PGHYBRID_OWNED_JOURNAL, new URL(context.connectionString).pathname.slice(1) + '\\n');
  await original.setup(context);
} };
`);
      const protocol = adapter === 'postgresjs' ? 'describe-flush-v1' : 'sync-cycle-v1';
      execute(process.execPath, [cli, 'run', entry, '--project-root', app, '--include', 'vendor',
        '--fixture-profile', 'postgresql17-pgvector0.8.6-v1', '--protocol-profile', protocol,
        '--max-runs', '1', ...budget, '--out', artifact, '--json'], app, 4);
      const first = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
      expect(first.outcome, first.reason).toBe('passed'); expect(first.cleanup.complete).toBe(true);
      expect(first.limits.timeoutMs).toBe(timeoutMs);
      expect(first.environment.source?.components.runtime.mode).toBe('build');
      expect(first.environment.source?.components.source.files.some(file => file.path === 'vendor/LICENSE')).toBe(true);
      const packages = first.environment.source!.components.dependencies.packages;
      for (const [name, version] of Object.entries(pins)) expect(packages.some(pkg => pkg.name === name && pkg.version === version && pkg.files.length > 0)).toBe(true);
      expect(first.trace.filter(step => step.sql.includes('websearch_to_tsquery') && step.completion?.kind !== 'metadata')).toHaveLength(4);
      expect(first.actors.map(actor => actor.value)).toEqual(Array.from({ length: 2 }, () => Array.from({ length: 2 }, () =>
        ['Termination for convenience', 'Renewal pricing', 'Renewal terms'])));
      const repeated = parseRunArtifact(JSON.parse(execute(process.execPath, [cli, 'replay', entry, artifact, ...budget, '--json'], app)));
      expect(repeated.outcome, repeated.reason).toBe('passed'); expect(repeated.cleanup.complete).toBe(true);
      expect(repeated.limits.timeoutMs).toBe(timeoutMs);
      expect(repeated.environment.source).toEqual(first.environment.source);
      expect(repeated.environment.fixture).toEqual(first.environment.fixture);
      expect(repeated.connections).toEqual(first.connections);
      expect(repeated.trace.map(step => step.fingerprint)).toEqual(first.trace.map(step => step.fingerprint));
      expect(repeated.actors).toEqual(first.actors);
      if (adapter === 'pg-pool') {
        const loaded = await readFile(imports), owned = await readFile(journal);
        const driver = join(app, 'node_modules/pg/lib/client.js'), bytes = await readFile(driver);
        try {
          await writeFile(driver, Buffer.concat([bytes, Buffer.from('\n// qualification: changed installed driver bytes\n')]));
          const drift = parseRunArtifact(JSON.parse(execute(process.execPath, [cli, 'replay', entry, artifact, ...budget, '--json'], app, 3)));
          expect(drift.outcome).toBe('incompatible'); expect(drift.reason).toMatch(/source|dependency|runtime/i);
          expect(drift.limits.timeoutMs).toBe(timeoutMs);
          expect(drift.trace).toEqual([]); expect(drift.cleanup.complete).toBe(true);
          expect(await readFile(imports)).toEqual(loaded);
          expect(await readFile(journal)).toEqual(owned);
        } finally { await writeFile(driver, bytes); }
      }
      console.log(JSON.stringify({ pghybridInstalledAdapter: { adapter, protocol, node: first.environment.nodeVersion,
        server: first.environment.serverVersion, sourceFingerprint: first.environment.source!.fingerprint,
        files: first.environment.source!.fileCount, releasedSteps: first.trace.length, exactReplay: true } }));
    }
    expect(await readFile(join(app, 'package-lock.json'))).toEqual(lock);
  } finally {
    const names = await readFile(journal, 'utf8').then(value => value.trim().split('\n'), error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
    try {
      const remaining = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names])).rows;
      console.log(JSON.stringify({ pghybridInstalledCleanup: { names, remaining } })); expect(remaining).toEqual([]);
    } finally { await admin.end(); await rm(root, { recursive: true, force: true }); }
  }
}, 180_000);
