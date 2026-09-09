import { parseArgs } from 'node:util';

const definitions = {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' }, force: { type: 'boolean' }, guided: { type: 'boolean' },
  safe: { type: 'boolean' }, 'keep-going': { type: 'boolean' },
  'database-url': { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' },
  'project-root': { type: 'string' }, include: { type: 'string', multiple: true },
  'max-steps': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'max-evidence-bytes': { type: 'string' },
  'max-connections-per-actor': { type: 'string' },
  'protocol-profile': { type: 'string' },
  'fixture-profile': { type: 'string' },
  'max-runs': { type: 'string' }, 'total-timeout-ms': { type: 'string' },
  'max-candidates': { type: 'string' }, 'max-search-bytes': { type: 'string' }, 'max-attempts': { type: 'string' },
} as const;
const runFlags = ['database-url', 'out', 'force', 'max-steps', 'timeout-ms', 'max-evidence-bytes', 'max-connections-per-actor', 'protocol-profile', 'fixture-profile'];
const searchFlags = ['max-runs', 'total-timeout-ms', 'max-candidates', 'max-search-bytes', 'keep-going', 'plan'];
const sourceFlags = ['project-root', 'include'];
const allowed: Record<string, string[]> = {
  init: [], run: [...runFlags, ...searchFlags, ...sourceFlags],
  replay: [...runFlags, 'guided', ...sourceFlags], minimize: [...runFlags, 'max-attempts', 'total-timeout-ms', ...sourceFlags],
  doctor: [...runFlags], demo: [...runFlags, 'safe'], report: ['out', 'force'],
  export: ['out', 'project-root', 'include'],
};
const numbers: Record<string, [number, number]> = {
  'max-steps': [1, 100_000], 'timeout-ms': [1, 600_000], 'max-evidence-bytes': [1024, 12 * 1024 * 1024],
  'max-connections-per-actor': [1, 8],
  'max-runs': [1, 10_000], 'total-timeout-ms': [1, 3_600_000],
  'max-candidates': [1, 100_000], 'max-search-bytes': [1024, 256 * 1024 * 1024], 'max-attempts': [1, 10_000],
};

export function parseCliArgs(args: string[]) {
  const parsed = parseArgs({ args, options: definitions, allowPositionals: true, strict: true, tokens: true });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name) && token.name !== 'include') throw new TypeError(`Option --${token.name} may only be supplied once`);
    seen.add(token.name);
  }
  const command = parsed.positionals[0];
  if (command && !Object.hasOwn(allowed, command)) throw new TypeError(`Unknown command: ${command}`);
  if (command) {
    for (const key of Object.keys(parsed.values)) {
      if (!['help', 'version', 'json'].includes(key) && !allowed[command]!.includes(key)) throw new TypeError(`Option --${key} is not supported by ${command}`);
    }
  }
  if (parsed.values.force && !parsed.values.out) throw new TypeError('--force requires --out');
  if (parsed.values['protocol-profile'] !== undefined && !['sync-cycle-v1', 'describe-flush-v1'].includes(parsed.values['protocol-profile'])) {
    throw new TypeError('--protocol-profile must be sync-cycle-v1 or describe-flush-v1');
  }
  if (parsed.values['fixture-profile'] !== undefined && !['native', 'postgresql17-pgvector0.8.6-v1'].includes(parsed.values['fixture-profile'])) {
    throw new TypeError('--fixture-profile must be native or postgresql17-pgvector0.8.6-v1');
  }
  for (const [key, [min, max]] of Object.entries(numbers)) {
    const value = parsed.values[key as keyof typeof definitions];
    if (value !== undefined && (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max)) {
      throw new TypeError(`--${key} must be an integer from ${min} to ${max}`);
    }
  }
  const plan = parsed.values.plan?.split(',');
  if (plan && (plan.length > 100_000 || plan.some(actor => !/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(actor) || ['constructor', 'prototype', '__proto__'].includes(actor)))) throw new TypeError('--plan must be comma-separated actor names');
  return { command, values: parsed.values, positionals: parsed.positionals.slice(1), plan };
}

export const HELP = `Interleave — find and replay races in real PostgreSQL

Usage:
  interleave init [directory]
  interleave run <scenario.mjs> [options]
  interleave replay <scenario.mjs> <run.json> [--guided] [options]
  interleave minimize <scenario.mjs> <run.json> [options]
  interleave export <scenario.mjs> <run.json> --project-root <dir> --out <dir>
  interleave report <run.json> --out <report.html>
  interleave doctor [options]
  interleave demo [neveroversell] [--safe] [options]

Database: --database-url <url> or TEST_DATABASE_URL must name a dedicated test
administrator database. Every execution creates and removes its own database.

Common: --json, --help, --version
Per run: --max-steps <n>, --timeout-ms <n>, --max-evidence-bytes <n>
Connections: --max-connections-per-actor <1..8>; extra sessions must remain queryless
Protocol: --protocol-profile <sync-cycle-v1|describe-flush-v1>; default sync-cycle-v1
Fixture: --fixture-profile <native|postgresql17-pgvector0.8.6-v1>; default native
Search: --max-runs <n>, --total-timeout-ms <n>, --max-candidates <n>,
        --max-search-bytes <n>, --plan <alice,bob,...>, --keep-going
Reduction: --max-attempts <n>, --total-timeout-ms <n>

Run/replay/minimize: --out <run.json> writes one retained run.
Source inputs: --project-root <dir>, repeated --include <relative-path>.
Export: --project-root <dir>, --out <new-directory>, repeated --include <path>.
--force permits atomic replacement of run artifacts and reports. init and export never overwrite.
Exact replay is default; --guided creates separately labeled new evidence.
Artifacts preserve private SQL and selected observations, which may be sensitive.

Exit codes: 0 checked success; 1 violation; 2 usage/actor/harness error;
3 incompatible replay; 4 inconclusive or exhausted safety budget; 130 SIGINT.
Reports are standalone offline HTML; opening or writing one does not execute a scenario.
`;
