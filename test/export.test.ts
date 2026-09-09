import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { exportRegression, verifyRegressionExport } from '../src/export.js';
import { HELP, parseCliArgs } from '../src/cli/options.js';
import type { RunResult } from '../src/types.js';
import { bindExportFixture } from './helpers/export.js';

const temporary: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fixtureProject(): Promise<{ projectRoot: string; scenarioFile: string }> {
  const projectRoot = await temporaryDirectory('interleave export project ');
  await mkdir(join(projectRoot, 'src'));
  await writeFile(
    join(projectRoot, 'src', 'scenario.mjs'),
    "import { operation } from './operation.mjs';\nexport default { operation };\n",
  );
  await writeFile(join(projectRoot, 'src', 'operation.mjs'), 'export const operation = 42;\n');
  await writeJson(join(projectRoot, 'package.json'), {
    name: 'export-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: {},
  });
  await writeJson(join(projectRoot, 'package-lock.json'), {
    name: 'export-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'export-fixture', version: '1.0.0', dependencies: {} } },
  });
  return { projectRoot, scenarioFile: join(projectRoot, 'src', 'scenario.mjs') };
}

async function fixtureRuntime(): Promise<string> {
  const runtimeRoot = await temporaryDirectory('interleave export runtime ');
  await mkdir(join(runtimeRoot, 'dist'));
  await writeJson(join(runtimeRoot, 'package.json'), {
    name: '@pavangupta352/interleave',
    version: '0.1.0-test',
    type: 'module',
    bin: { interleave: 'dist/cli.js' },
    files: ['dist'],
  });
  for (const file of ['cli.js', 'export.js', 'index.js', 'source-identity.js']) {
    await writeFile(join(runtimeRoot, 'dist', file), 'export {};\n');
  }
  return runtimeRoot;
}

function completedViolation(): RunResult {
  return {
    schemaVersion: 1,
    scenario: 'portable-counter',
    outcome: 'violation',
    mode: 'explore',
    plan: [],
    trace: [],
    actors: [
      { actor: 'alice', status: 'fulfilled', value: 1 },
      { actor: 'bob', status: 'fulfilled', value: 1 },
    ],
    failure: {
      name: 'AssertionError',
      message: 'both increments survive',
      fingerprint: 'a'.repeat(64),
    },
    environment: { serverVersion: '16.13', nodeVersion: 'v24.7.0' },
    startedAt: '2026-09-09T00:00:00.000Z',
    durationMs: 1,
    limits: { maxSteps: 100, timeoutMs: 10_000 },
    cleanup: { complete: true },
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('regression export', () => {
  test('parses an explicit export source, destination and repeated include paths', () => {
    const parsed = parseCliArgs([
      'export', 'scenario.mjs', 'run.json', '--project-root', '.', '--out', 'regression',
      '--include', 'src/helpers', '--include', 'migrations/001.sql',
    ]);

    expect(parsed.command).toBe('export');
    expect(parsed.positionals).toEqual(['scenario.mjs', 'run.json']);
    expect(parsed.values.include).toEqual(['src/helpers', 'migrations/001.sql']);
    expect(HELP).toContain('interleave export <scenario.mjs> <run.json>');
    expect(() => parseCliArgs(['export', 'scenario.mjs', 'run.json', '--out', 'regression', '--force'])).toThrow(/force|supported/i);
  });

  test('copies the scenario graph, lock, artifact and current runtime into a verified folder', async () => {
    const { projectRoot, scenarioFile } = await fixtureProject();
    const runtimeRoot = await fixtureRuntime();
    const destination = join(await temporaryDirectory('interleave export destination '), 'ready regression');
    await mkdir(join(projectRoot, 'fixtures'));
    await writeFile(join(projectRoot, 'fixtures', 'seed.json'), '{"value":0}\n');

    const bound = await bindExportFixture(completedViolation(), { scenarioFile, projectRoot, runtimeRoot, include: ['fixtures'] });
    const exported = await exportRegression(bound, {
      scenarioFile,
      projectRoot,
      destination,
      include: ['fixtures'],
      runtimeRoot,
    });
    const verified = await verifyRegressionExport(destination);

    expect(verified.fingerprint).toBe(exported.fingerprint);
    expect(verified.scenario.entry).toBe('app/src/scenario.mjs');
    expect(verified.files.map((file) => file.path)).toEqual([
      'app/fixtures/seed.json',
      'app/package-lock.json',
      'app/package.json',
      'app/src/operation.mjs',
      'app/src/scenario.mjs',
      'package-lock.json',
      'package.json',
      'run.json',
      'runtime/pavangupta352-interleave-0.1.0-test.tgz',
    ]);
    expect(await readFile(join(destination, 'app/src/scenario.mjs'), 'utf8')).toContain("'./operation.mjs'");
    expect(JSON.parse(await readFile(join(destination, 'run.json'), 'utf8'))).toEqual(bound);
  });

  test('rejects incomplete source graphs instead of silently omitting imports', async () => {
    const { projectRoot, scenarioFile } = await fixtureProject();
    const runtimeRoot = await fixtureRuntime();
    await writeFile(scenarioFile, "import './missing-operation.mjs';\nexport default {};\n");

    await expect(exportRegression(completedViolation(), {
      scenarioFile,
      projectRoot,
      destination: join(await temporaryDirectory('interleave missing import '), 'regression'),
      runtimeRoot,
    })).rejects.toThrow(/missing-operation|could not be resolved|complete local source/i);
  });

  test.each(['completion', 'UTF-8'] as const)('rejects a rehashed bundle with invalid %s evidence', async boundary => {
    const { projectRoot, scenarioFile } = await fixtureProject();
    const runtimeRoot = await fixtureRuntime();
    const destination = join(await temporaryDirectory('interleave incomplete evidence '), 'regression');
    const run = completedViolation();
    run.trace = [{
      index: 0, actor: 'alice', connection: 0, ordinal: 0, protocol: 'simple',
      sql: 'SELECT 1', fingerprint: 'b'.repeat(64), backendPid: 123,
      available: ['alice'], releasedAt: 0, completedAt: 1, waits: [],
      completion: { transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 },
    }];
    const bound = await bindExportFixture(run, { scenarioFile, projectRoot, runtimeRoot });
    await exportRegression(bound, { scenarioFile, projectRoot, destination, runtimeRoot });
    if (boundary === 'completion') {
      delete bound.trace[0]!.completion;
      delete bound.trace[0]!.completedAt;
    }
    const bytes = Buffer.from(`${JSON.stringify(bound, null, 2)}\n`);
    if (boundary === 'UTF-8') {
      const offset = bytes.indexOf('both increments survive');
      expect(offset).toBeGreaterThan(0);
      bytes[offset] = 0xff;
    }
    await writeFile(join(destination, 'run.json'), bytes);
    const manifestPath = join(destination, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const entry = manifest.files.find((file: { path: string }) => file.path === 'run.json');
    entry.bytes = bytes.length;
    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
    const { fingerprint: _ignored, ...unsigned } = manifest;
    manifest.fingerprint = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    await writeJson(manifestPath, manifest);
    await expect(verifyRegressionExport(destination).then(() => 'verified')).rejects.toThrow(boundary === 'completion' ? /complet/i : /UTF-8/i);
  });

  test('rejects traversal, symbolic-link escapes and existing destinations without changing them', async () => {
    const { projectRoot } = await fixtureProject();
    const runtimeRoot = await fixtureRuntime();
    const outside = join(await temporaryDirectory('interleave outside source '), 'outside.mjs');
    await writeFile(outside, 'export default {};\n');
    const destinationParent = await temporaryDirectory('interleave preserved destination ');
    const occupied = join(destinationParent, 'occupied');
    await mkdir(occupied);
    await writeFile(join(occupied, 'sentinel'), 'preserve');

    await expect(exportRegression(completedViolation(), {
      scenarioFile: outside,
      projectRoot,
      destination: join(destinationParent, 'escape'),
      runtimeRoot,
    })).rejects.toThrow(/escape|project root/i);
    await expect(exportRegression(completedViolation(), {
      scenarioFile: join(projectRoot, 'src/scenario.mjs'),
      projectRoot,
      destination: join(destinationParent, 'include traversal'),
      include: ['../outside'],
      runtimeRoot,
    })).rejects.toThrow(/escape|relative|project root/i);
    await expect(exportRegression(completedViolation(), {
      scenarioFile: join(projectRoot, 'src/scenario.mjs'),
      projectRoot,
      destination: occupied,
      include: ['../outside'],
      runtimeRoot,
    })).rejects.toThrow(/already exists|overwrite/i);
    expect(await readFile(join(occupied, 'sentinel'), 'utf8')).toBe('preserve');

    const link = join(projectRoot, 'src/link.mjs');
    await symlink(outside, link);
    await writeFile(join(projectRoot, 'src/scenario.mjs'), "import './link.mjs';\nexport default {};\n");
    await expect(exportRegression(completedViolation(), {
      scenarioFile: join(projectRoot, 'src/scenario.mjs'),
      projectRoot,
      destination: join(destinationParent, 'symlink export'),
      runtimeRoot,
    })).rejects.toThrow(/symbolic link/i);
  });

  test('detects tampering in source, artifact, lock, runtime and manifest without executing JSON', async () => {
    const { projectRoot, scenarioFile } = await fixtureProject();
    const runtimeRoot = await fixtureRuntime();
    const destination = join(await temporaryDirectory('interleave tamper destination '), 'regression');
    await exportRegression(await bindExportFixture(completedViolation(), { scenarioFile, projectRoot, runtimeRoot }), { scenarioFile, projectRoot, destination, runtimeRoot });
    const manifestPath = join(destination, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      runtime: { package: string };
      createdAt: string;
    };
    const targets = [
      join(destination, 'app/src/scenario.mjs'),
      join(destination, 'run.json'),
      join(destination, 'app/package-lock.json'),
      join(destination, ...manifest.runtime.package.split('/')),
    ];
    for (const target of targets) {
      const original = await readFile(target);
      await writeFile(target, Buffer.concat([original, Buffer.from('tampered')]));
      await expect(verifyRegressionExport(destination)).rejects.toThrow(/integrity/i);
      await writeFile(target, original);
    }

    const originalManifest = await readFile(manifestPath, 'utf8');
    manifest.createdAt = '2026-09-10T00:00:00.000Z';
    await writeJson(manifestPath, manifest);
    await expect(verifyRegressionExport(destination)).rejects.toThrow(/fingerprint/i);
    await writeFile(manifestPath, originalManifest);
    await expect(verifyRegressionExport(destination)).resolves.toMatchObject({
      kind: 'interleave-regression',
    });

    const executable = JSON.parse(originalManifest) as Record<string, unknown> & {
      fingerprint: string;
      replay: { command: string[] };
    };
    executable.replay.command = ['rm', '-rf', '.'];
    const { fingerprint: _ignored, ...unsigned } = executable;
    executable.fingerprint = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    await writeJson(manifestPath, executable);
    await expect(verifyRegressionExport(destination)).rejects.toThrow(/replay commands|exactly match/i);
  });

  test('accepts only completed violation evidence with complete cleanup', async () => {
    const { projectRoot, scenarioFile } = await fixtureProject();
    const runtimeRoot = await fixtureRuntime();
    const run = completedViolation();
    run.outcome = 'passed';
    delete run.failure;
    await expect(exportRegression(run, {
      scenarioFile,
      projectRoot,
      destination: join(await temporaryDirectory('interleave passed run '), 'regression'),
      runtimeRoot,
    })).rejects.toThrow(/violation/i);

    const unclean = completedViolation();
    unclean.cleanup = { complete: false, error: 'cleanup failed' };
    await expect(exportRegression(unclean, {
      scenarioFile,
      projectRoot,
      destination: join(await temporaryDirectory('interleave unclean run '), 'regression'),
      runtimeRoot,
    })).rejects.toThrow(/cleanup/i);
  });
});
