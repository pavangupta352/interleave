#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { explore } from './explore.js';
import { replay } from './replay.js';
import { minimize, MinimizationVerificationError } from './minimize.js';
import { readRunArtifact, writeRunArtifact } from './artifact.js';
import { writeReport } from './report.js';
import { runScenarioFile } from './supervised.js';
import { HELP, parseCliArgs } from './cli/options.js';
import { explorationExitCode, minimizationExitCode, runExitCode } from './cli/status.js';
import { doctor } from './cli/doctor.js';
import { initializeProject } from './cli/init.js';
import { loadNeveroversell } from './cli/demo.js';
import { exportRegression, type ExportRegressionResult } from './export.js';
import type { ExplorationResult, MinimizationResult, RunOptions, RunResult } from './types.js';

const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const controller = new AbortController();
let signal: NodeJS.Signals | undefined;
const onInterrupt = (): void => { signal ??= 'SIGINT'; controller.abort(); };
const onTerminate = (): void => { signal ??= 'SIGTERM'; controller.abort(); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
let json = process.argv.slice(2).includes('--json');
try {
  const code = await main(process.argv.slice(2));
  process.exitCode = signal ? signal === 'SIGINT' ? 130 : 143 : code;
} catch (error) {
  const message = error instanceof Error ? error.message : 'Command failed';
  const code = signal ? signal === 'SIGINT' ? 130 : 143
    : error instanceof MinimizationVerificationError && error.outcome === 'incompatible' ? 3
    : error instanceof MinimizationVerificationError && error.outcome === 'inconclusive' ? 4 : 2;
  if (json) process.stdout.write(`${JSON.stringify({ error: { message }, exitCode: code })}\n`);
  else process.stderr.write(`interleave: ${message}\n`);
  process.exitCode = code;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}

async function main(args: string[]): Promise<number> {
  const parsed = parseCliArgs(args);
  const { command, values, positionals } = parsed;
  json = values.json ?? false;
  if (values.version) { output({ version: metadata.version }, metadata.version); return 0; }
  if (values.help || !command) { output({ help: HELP, version: metadata.version }, HELP.trimEnd()); return 0; }
  if (command === 'report') {
    if (positionals.length !== 1 || !values.out?.trim()) throw new TypeError('Usage: interleave report <run.json> --out <report.html>');
    const run = await readRunArtifact(positionals[0]!);
    await writeReport(values.out, run, { overwrite: values.force ?? false });
    output({ path: values.out, scenario: run.scenario, outcome: run.outcome }, `Wrote offline evidence report: ${values.out}`);
    return 0;
  }
  if (command === 'init') {
    if (positionals.length > 1) throw new TypeError('Usage: interleave init [directory]');
    const created = await initializeProject(positionals[0] ?? 'interleave-scenario', metadata.version);
    output(created, `Created ${created.directory}\n${created.nextSteps.join('\n')}`);
    return 0;
  }
  if (command === 'export') {
    if (positionals.length !== 2 || !values['project-root'] || !values.out) {
      throw new TypeError('Usage: interleave export <scenario.mjs> <run.json> --project-root <dir> --out <new-directory>');
    }
    const run = await readRunArtifact(positionals[1]!);
    const exported = await exportRegression(run, {
      scenarioFile: positionals[0]!,
      projectRoot: values['project-root'],
      destination: values.out,
      ...(values.include === undefined ? {} : { include: values.include }),
    });
    output(exported, describeExport(exported));
    return 0;
  }
  const expected = command === 'replay' || command === 'minimize' ? 2 : command === 'run' ? 1 : 0;
  if (command === 'demo') {
    if (positionals.length > 1 || (positionals[0] !== undefined && positionals[0] !== 'neveroversell')) throw new TypeError('Usage: interleave demo [neveroversell] [--safe]');
  } else if (positionals.length !== expected) throw new TypeError(`Invalid arguments for ${command}; run interleave --help for usage`);
  const databaseUrl = values['database-url'] ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl?.trim()) throw new TypeError('Set --database-url or TEST_DATABASE_URL to a dedicated PostgreSQL administrator database');
  const options: RunOptions = {
    databaseUrl, signal: controller.signal,
    ...((values['project-root'] === undefined && values.include === undefined) ? {} : { source: {
      ...(values['project-root'] === undefined ? {} : { projectRoot: values['project-root'] }),
      ...(values.include === undefined ? {} : { include: values.include }),
    } }),
    ...(values['max-steps'] === undefined ? {} : { maxSteps: Number(values['max-steps']) }),
    ...(values['timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['timeout-ms']) }),
    ...(values['max-evidence-bytes'] === undefined ? {} : { maxEvidenceBytes: Number(values['max-evidence-bytes']) }),
    ...(values['max-connections-per-actor'] === undefined ? {} : { maxConnectionsPerActor: Number(values['max-connections-per-actor']) }),
  };
  let result: RunResult | ExplorationResult | MinimizationResult;
  let run: RunResult | undefined;
  let code: number;
  if (command === 'run') {
    const search = await explore(positionals[0]!, {
      ...options,
      ...(parsed.plan === undefined ? {} : { plan: parsed.plan }),
      ...(values['max-runs'] === undefined ? {} : { maxRuns: Number(values['max-runs']) }),
      ...(values['total-timeout-ms'] === undefined ? {} : { totalTimeoutMs: Number(values['total-timeout-ms']) }),
      ...(values['max-candidates'] === undefined ? {} : { maxCandidates: Number(values['max-candidates']) }),
      ...(values['max-search-bytes'] === undefined ? {} : { maxSearchBytes: Number(values['max-search-bytes']) }),
      ...(values['keep-going'] ? { stopOnFailure: false } : {}),
    });
    result = search; run = search.firstFailure ?? search.runs.at(-1); code = explorationExitCode(search);
  } else if (command === 'replay' || command === 'minimize') {
    const original = await readRunArtifact(positionals[1]!);
    if (command === 'replay') {
      run = await replay(positionals[0]!, original, { ...options, ...(values.guided ? { mode: 'guided' as const } : {}) });
      result = run; code = runExitCode(run);
    } else {
      const reduced = await minimize(positionals[0]!, original, {
        ...options,
        ...(values['max-attempts'] === undefined ? {} : { maxAttempts: Number(values['max-attempts']) }),
        ...(values['total-timeout-ms'] === undefined ? {} : { totalTimeoutMs: Number(values['total-timeout-ms']) }),
      });
      result = reduced; run = reduced.run; code = minimizationExitCode(reduced);
    }
  } else if (command === 'doctor') {
    run = await doctor(options); result = run; code = runExitCode(run);
  } else {
    const module = await loadNeveroversell();
    const fixture = new URL(`${import.meta.url.endsWith('.ts') ? '../dist/' : './'}examples/neveroversell/demo-${values.safe ? 'safe' : 'naive'}.js`, import.meta.url);
    run = await runScenarioFile(fileURLToPath(fixture), { ...options,
      source: { projectRoot: fileURLToPath(new URL('../', import.meta.url)), include: ['dist/examples/neveroversell/vendor/sql'] },
      ...(values.safe ? {} : { plan: [...module.NAIVE_OVERSELL_PLAN] }) });
    result = run; code = runExitCode(run);
  }
  if (values.out) {
    if (run) await writeRunArtifact(values.out, run, { overwrite: values.force ?? false });
    else if (!json) process.stderr.write('No retained execution was available to write; inspect the search budget result.\n');
  }
  output(result, describe(result));
  return signal ? signal === 'SIGINT' ? 130 : 143 : code;
}

function output(value: unknown, human: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${human}\n`);
}
function describeExport(result: ExportRegressionResult): string {
  const commands = [
    ...result.replay.install,
    result.replay.command,
  ].map((args) => args.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(' '));
  return `Exported verified regression to ${result.destination}\nManifest: ${result.manifestPath}\nFingerprint: ${result.fingerprint}\nReplay from that directory:\n${commands.join('\n')}`;
}
function describe(result: RunResult | ExplorationResult | MinimizationResult): string {
  if ('explored' in result) return `${result.scenario}: ${result.explored} runs, ${result.violationCount} violations; ${result.stopReason}.\n${result.coverage}`;
  if ('reducedChoices' in result) {
    const failed = result.attemptFailure;
    const attempt = failed ? `\nReduction trial failed (${failed.outcome}).${failed.reason ? `\n${failed.reason}` : ''}${!failed.cleanup.complete ? `\nCleanup incomplete: ${failed.cleanup.error ?? 'Owned resource cleanup could not be confirmed'}` : ''}` : '';
    return `Reduced ${result.originalChoices} choices to ${result.reducedChoices} in ${result.attempts} attempts; ${result.stopReason}.${result.reason ? `\n${result.reason}` : ''}\n${describe(result.run)}${attempt}`;
  }
  return `${result.scenario}: ${result.outcome} (${result.mode}); ${result.trace.length} commands; cleanup ${result.cleanup.complete ? 'complete' : 'incomplete'}.${result.reason ? `\n${result.reason}` : ''}${result.failure ? `\n${result.failure.message}` : ''}`;
}
