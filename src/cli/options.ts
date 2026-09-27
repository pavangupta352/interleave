import { parseArgs } from 'node:util';
import { normalizeExplorationSearch } from '../exploration-search.js';
import { parsePlanChoice } from '../lanes.js';

const definitions = {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' }, force: { type: 'boolean' }, guided: { type: 'boolean' },
  safe: { type: 'boolean' }, 'keep-going': { type: 'boolean' },
  docker: { type: 'boolean' }, 'postgres-image': { type: 'string' },
  'database-url': { type: 'string' }, 'upstream-tls': { type: 'boolean' }, 'upstream-ca': { type: 'string' },
  out: { type: 'string' }, plan: { type: 'string' },
  'project-root': { type: 'string' }, include: { type: 'string', multiple: true },
  'runtime-archive': { type: 'string' }, 'dependency-archive': { type: 'string', multiple: true },
  'max-steps': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'max-evidence-bytes': { type: 'string' },
  'max-connections-per-actor': { type: 'string' },
  'connection-profile': { type: 'string' },
  'protocol-profile': { type: 'string' },
  overlap: { type: 'string' },
  'fixture-profile': { type: 'string' },
  'max-runs': { type: 'string' }, 'total-timeout-ms': { type: 'string' },
  strategy: { type: 'string' }, seed: { type: 'string' },
  'max-candidates': { type: 'string' }, 'max-search-bytes': { type: 'string' }, 'max-attempts': { type: 'string' },
} as const;
const runFlags = ['database-url', 'upstream-tls', 'upstream-ca', 'docker', 'postgres-image', 'out', 'force', 'max-steps', 'timeout-ms', 'max-evidence-bytes', 'max-connections-per-actor', 'connection-profile', 'protocol-profile', 'fixture-profile'];
export const POSTGRES_IMAGES = ['postgres:16', 'postgres:17', 'postgres:18', 'pgvector/pgvector:0.8.6-pg17-bookworm'] as const;
const searchFlags = ['max-runs', 'total-timeout-ms', 'max-candidates', 'max-search-bytes', 'keep-going', 'plan', 'strategy', 'seed'];
const sourceFlags = ['project-root', 'include'];
const allowed: Record<string, string[]> = {
  init: [], run: [...runFlags, ...searchFlags, ...sourceFlags, 'overlap'],
  replay: [...runFlags, 'guided', ...sourceFlags], minimize: [...runFlags, 'max-attempts', 'total-timeout-ms', ...sourceFlags],
  doctor: [...runFlags], demo: [...runFlags, 'safe'], report: ['out', 'force'],
  export: ['out', 'project-root', 'include', 'runtime-archive', 'dependency-archive'],
};
const numbers: Record<string, [number, number]> = {
  'max-steps': [1, 100_000], 'timeout-ms': [1, 600_000], 'max-evidence-bytes': [1024, 12 * 1024 * 1024],
  'max-connections-per-actor': [1, 8],
  'max-runs': [1, 10_000], 'total-timeout-ms': [1, 3_600_000],
  seed: [0, 4_294_967_295],
  'max-candidates': [1, 100_000], 'max-search-bytes': [1024, 256 * 1024 * 1024], 'max-attempts': [1, 10_000],
};

export function parseCliArgs(args: string[]) {
  const parsed = parseArgs({ args, options: definitions, allowPositionals: true, strict: true, tokens: true });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name) && !['include', 'dependency-archive'].includes(token.name)) throw new TypeError(`Option --${token.name} may only be supplied once`);
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
  if (parsed.values['postgres-image'] !== undefined && !parsed.values.docker) throw new TypeError('--postgres-image requires --docker');
  if (parsed.values['postgres-image'] !== undefined && !POSTGRES_IMAGES.includes(parsed.values['postgres-image'] as typeof POSTGRES_IMAGES[number])) throw new TypeError('--postgres-image must be a qualified PostgreSQL image: ' + POSTGRES_IMAGES.join(', '));
  if (parsed.values.docker && parsed.values['database-url'] !== undefined) throw new TypeError('--docker cannot be combined with --database-url');
  if (parsed.values['upstream-ca'] !== undefined && !parsed.values['upstream-tls']) throw new TypeError('--upstream-ca requires --upstream-tls');
  if (parsed.values.docker && parsed.values['upstream-tls']) throw new TypeError('--docker provisions a plaintext loopback server; use --database-url with --upstream-tls');
  if (parsed.values['fixture-profile'] === 'postgresql17-pgvector0.8.6-v1' && parsed.values['postgres-image'] !== undefined && parsed.values['postgres-image'] !== POSTGRES_IMAGES[3]) throw new TypeError('The pgvector fixture profile requires its matching pgvector image');
  if (parsed.values['protocol-profile'] !== undefined && !['sync-cycle-v1', 'describe-flush-v1'].includes(parsed.values['protocol-profile'])) {
    throw new TypeError('--protocol-profile must be sync-cycle-v1 or describe-flush-v1');
  }
  if (parsed.values['connection-profile'] !== undefined && !['single-producer-v1', 'multi-producer-v1'].includes(parsed.values['connection-profile'])) {
    throw new TypeError('--connection-profile must be single-producer-v1 or multi-producer-v1');
  }
  if (parsed.values.overlap !== undefined && parsed.values.overlap !== 'pairs') throw new TypeError('--overlap must be pairs');
  if (parsed.values['fixture-profile'] !== undefined && !['native', 'postgresql17-pgvector0.8.6-v1'].includes(parsed.values['fixture-profile'])) {
    throw new TypeError('--fixture-profile must be native or postgresql17-pgvector0.8.6-v1');
  }
  for (const [key, [min, max]] of Object.entries(numbers)) {
    const value = parsed.values[key as keyof typeof definitions];
    if (value !== undefined && (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max)) {
      throw new TypeError(`--${key} must be an integer from ${min} to ${max}`);
    }
  }
  normalizeExplorationSearch({
    ...(parsed.values.strategy === undefined ? {} : { strategy: parsed.values.strategy }),
    ...(parsed.values.seed === undefined ? {} : { seed: Number(parsed.values.seed) }),
  });
  const plan = parsed.values.plan?.split(',');
  if (plan && (plan.length > 100_000 || plan.some(entry => parsePlanChoice(entry) === undefined))) throw new TypeError('--plan must be comma-separated actor names');
  const choices = plan?.map(entry => parsePlanChoice(entry)!) ?? [];
  if (choices.some(choice => choice.some(item => item.connection !== undefined)) && parsed.values['connection-profile'] !== 'multi-producer-v1') {
    throw new TypeError('--plan lanes such as alice#1 require --connection-profile multi-producer-v1');
  }
  if (choices.some(choice => choice.length > 1) && parsed.values.overlap !== 'pairs') {
    throw new TypeError('--plan pairs such as alice+bob require --overlap pairs');
  }
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

Database: --docker starts and removes an owned local PostgreSQL server (Docker
required; first use may download its image). Or --database-url <url> or
TEST_DATABASE_URL must name a dedicated test administrator database.
Every execution creates and removes its own database. Do not combine both routes.
Managed image: --postgres-image <image> requires --docker; choose postgres:16
(native default), postgres:17, postgres:18, or pgvector/pgvector:0.8.6-pg17-bookworm.
The explicit pgvector fixture profile defaults to that vector image.
Upstream TLS: --upstream-tls verifies the server certificate chain and the URL
hostname/IP for every PostgreSQL connection (TLS 1.2-1.3, Node's bundled roots).
--upstream-ca <pem-file> replaces those roots with your CA bundle; it is read once.
URL sslmode=verify-full selects the same policy. Actor endpoints stay loopback plaintext.

Common: --json, --help, --version
Per run: --max-steps <n>, --timeout-ms <n>, --max-evidence-bytes <n>
Connections: --max-connections-per-actor <1..8>; extra sessions must remain queryless
             --connection-profile multi-producer-v1 schedules every actor connection as
             its own lane (default cap 8); --plan may then name lanes such as alice#1
Overlap: --overlap pairs (run) also explores releasing two actors' next commands
         together, so statements can race inside PostgreSQL; --plan may then name
         pairs such as alice+bob. Off by default.
Protocol: --protocol-profile <sync-cycle-v1|describe-flush-v1>; default sync-cycle-v1
Fixture: --fixture-profile <native|postgresql17-pgvector0.8.6-v1>; default native
Search: --max-runs <n>, --total-timeout-ms <n>, --max-candidates <n>,
        --max-search-bytes <n>, --plan <alice,bob,...>, --keep-going
        --strategy <fifo|seeded>, --seed <0..4294967295>
        Default: fifo. A seed selects seeded search; explicit fifo rejects a seed.
Reduction: --max-attempts <n>, --total-timeout-ms <n>

Run/replay/minimize: --out <run.json> writes one retained run.
Source inputs: --project-root <dir>, repeated --include <relative-path>.
Export: --project-root <dir>, --out <new-directory>, repeated --include <path>.
Shared export: --runtime-archive <original.tgz>, repeated --dependency-archive <original.tgz>.
--force permits atomic replacement of run artifacts and reports. init and export never overwrite.
Exact replay is default; --guided creates separately labeled new evidence.
Artifacts preserve private SQL and selected observations, which may be sensitive.

Exit codes: 0 checked success; 1 violation; 2 usage/actor/harness error;
3 incompatible replay; 4 inconclusive or exhausted safety budget; 130 SIGINT; 143 SIGTERM.
Reports are standalone offline HTML; opening or writing one does not execute a scenario.
`;
