import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { parseRunArtifact } from '../../src/artifact.js';
import { testDatabaseUrl } from './postgres.js';
import { npm } from './npm.js';

const repository = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

export interface LanguageExample {
  /** examples/<folder>, copied from the installed package into the application as <folder>/. */
  folder: string;
  /** Variables for every command, such as the interpreter the scenarios should use. */
  env: Record<string, string>;
  /** The README's preparation commands, run in order from the application root. */
  prepare: string[][];
  /** Paths for `--include`: the program, and any modules or settings it reads. */
  unsafe: { scenario: string; include: string | string[]; edit: { file: string; text: string } };
  /**
   * Startup parameters are part of exact replay identity. `moved` states whether a copy
   * of the application in another directory replays the recording; `changedStartup`
   * optionally names variables that change what the driver sends at startup.
   */
  replayElsewhere: { moved: 'same failure' | 'startup changed'; changedStartup?: Record<string, string> };
  /**
   * The repaired program's search: by default it must exhaust the frontier (exit 0). A
   * `max-runs` search covers that many orders without a violation and exits 4 because
   * its run budget, not the frontier, ended it.
   */
  safe: { scenario: string; include: string | string[]; budget: string[]; schedules: number; timeoutMs: number; stop?: 'frontier-exhausted' | 'max-runs' };
  /** Options the README gives every `run`, such as a protocol profile; replay inherits them. */
  runOptions?: string[];
}

/**
 * The installed-package workflow each language README documents: pack this checkout,
 * install it into a new application, copy the example in and run every command from
 * the application root. The unsafe program must oversell and exact replay must repeat
 * the failure; a copy of the application elsewhere must replay it as the driver's
 * startup parameters allow; an edited program must make exact replay incompatible;
 * and the safe program must pass a completely explored frontier. Set
 * INTERLEAVE_TEST_EVIDENCE to a directory to keep each command's status and output.
 */
export async function qualifyLanguageExample(example: LanguageExample): Promise<void> {
  const paths = (value: string | string[]): string[] => Array.isArray(value) ? value : [value];
  const includes = (value: string | string[]): string[] => paths(value).flatMap(path => ['--include', path]);
  const databaseUrl = testDatabaseUrl();
  const root = await mkdtemp(join(await realpath(tmpdir()), `interleave ${example.folder} actors `));
  const evidence = process.env.INTERLEAVE_TEST_EVIDENCE ? join(process.env.INTERLEAVE_TEST_EVIDENCE, example.folder) : undefined;
  if (evidence) await mkdir(evidence, { recursive: true });
  let step = 0;
  function execute(args: string[], cwd: string, expected: number, { timeout = 660_000, env = {} }: { timeout?: number; env?: Record<string, string> } = {}): string {
    const started = Date.now();
    const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...example.env, ...env, NODE_OPTIONS: '', TEST_DATABASE_URL: databaseUrl,
        npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
    if (evidence) {
      const name = String(++step).padStart(2, '0');
      writeFileSync(join(evidence, `${name}.stdout`), result.stdout ?? ''); writeFileSync(join(evidence, `${name}.stderr`), result.stderr ?? '');
      appendFileSync(join(evidence, 'commands.jsonl'), JSON.stringify({ step: name, command: args.map(arg => arg.replace(root, '<root>')), status: result.status, expected, milliseconds: Date.now() - started }) + '\n');
    }
    expect(result.error).toBeUndefined();
    expect(result.status, (result.stderr || result.stdout || '').slice(-3000)).toBe(expected);
    return result.stdout;
  }
  try {
    const packed = JSON.parse(execute(npm('pack', '--ignore-scripts', '--json', '--pack-destination', root), repository, 0))[0];
    const app = join(root, 'shop'); await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: `${example.folder}-shop`, private: true, type: 'module' }, null, 2) + '\n');
    execute(npm('install', join(root, packed.filename), '--ignore-scripts'), app, 0);
    const installed = join(app, 'node_modules/@pavangupta352/interleave');
    await cp(join(installed, 'examples', example.folder), join(app, example.folder), { recursive: true, filter: source => !source.endsWith('README.md') });
    for (const command of example.prepare) execute(command, app, 0);
    const cli = join(installed, 'dist/cli.js');
    const artifact = join(root, 'oversell.json');

    const found = JSON.parse(execute([process.execPath, cli, 'run', example.unsafe.scenario, ...includes(example.unsafe.include), ...example.runOptions ?? [], '--out', artifact, '--json'], app, 1));
    expect(found.violationCount).toBeGreaterThan(0);
    if (evidence) await cp(artifact, join(evidence, 'oversell.json'));
    const recorded = parseRunArtifact(JSON.parse(await readFile(artifact, 'utf8')));
    expect(recorded.outcome).toBe('violation');
    expect(recorded.failure?.message).toMatch(/one unit of stock was sold 2 times/);
    for (const path of paths(example.unsafe.include)) expect(recorded.environment.source?.includes).toContain(path);
    expect(recorded.actors.map(actor => actor.value)).toEqual([{ saw_stock: 1, bought: true }, { saw_stock: 1, bought: true }]);
    expect(new Set(recorded.trace.map(step => step.actor))).toEqual(new Set(['alice', 'bob']));

    const replay = [process.execPath, cli, 'replay', example.unsafe.scenario, artifact, '--json'];
    const repeated = parseRunArtifact(JSON.parse(execute(replay, app, 1)));
    expect(repeated.outcome).toBe('violation');
    expect(repeated.failure?.fingerprint).toBe(recorded.failure?.fingerprint);

    const moved = join(root, 'moved application');
    await cp(app, moved, { recursive: true, verbatimSymlinks: true });
    const elsewhere = parseRunArtifact(JSON.parse(execute([process.execPath, join(moved, 'node_modules/@pavangupta352/interleave/dist/cli.js'), ...replay.slice(2)], moved,
      example.replayElsewhere.moved === 'same failure' ? 1 : 3)));
    if (example.replayElsewhere.moved === 'same failure') expect(elsewhere.failure?.fingerprint).toBe(recorded.failure?.fingerprint);
    else expect(elsewhere.reason).toMatch(/startup identity changed/);
    if (example.replayElsewhere.changedStartup) {
      const changed = parseRunArtifact(JSON.parse(execute(replay, app, 3, { env: example.replayElsewhere.changedStartup })));
      expect(changed.reason).toMatch(/startup identity changed/);
    }

    await appendFile(join(app, example.unsafe.edit.file), example.unsafe.edit.text);
    const drift = parseRunArtifact(JSON.parse(execute(replay, app, 3)));
    expect(drift.outcome).toBe('incompatible');
    expect(drift.reason).toMatch(/source/i);

    // The README's command prints the search summary rather than every retained run.
    const stop = example.safe.stop ?? 'frontier-exhausted';
    const summary = execute([process.execPath, cli, 'run', example.safe.scenario, ...includes(example.safe.include), ...example.runOptions ?? [], ...example.safe.budget], app,
      stop === 'frontier-exhausted' ? 0 : 4, { timeout: example.safe.timeoutMs });
    const counts = /: (\d+) attempted, (\d+) completed; violations: (\d+); ([a-z-]+)\./.exec(summary)?.slice(1);
    expect(counts, summary).toEqual([String(example.safe.schedules), String(example.safe.schedules), '0', stop]);
  } finally { await rm(root, { recursive: true, force: true }); }
}
