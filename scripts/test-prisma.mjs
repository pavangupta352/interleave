import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';

// Deliberately separate from the root dependency graph and default test suite.
// An unqualified runtime is an explicit failure, never a skipped test row.
assert(['v22.18.0', 'v24.7.0'].includes(process.version), 'Prisma qualification requires Node.js 22.18.0 or 24.7.0');
assert(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a dedicated PostgreSQL administrator database');
assert(process.env.INTERLEAVE_PRISMA_RUNTIME_ARCHIVE, 'Set INTERLEAVE_PRISMA_RUNTIME_ARCHIVE to the Interleave package archive under test');
assert(process.env.INTERLEAVE_PRISMA_EVIDENCE, 'Set INTERLEAVE_PRISMA_EVIDENCE to a new evidence directory');
const archive = resolve(process.env.INTERLEAVE_PRISMA_RUNTIME_ARCHIVE);
const archiveBytes = await readFile(archive);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveSha256 = sha256(archiveBytes);
if (process.env.INTERLEAVE_PRISMA_RUNTIME_SHA256) {
  assert.equal(archiveSha256, process.env.INTERLEAVE_PRISMA_RUNTIME_SHA256, 'The runtime archive differs from the expected SHA-256');
}
const evidence = resolve(process.env.INTERLEAVE_PRISMA_EVIDENCE);

// Node resolves a package missing from the application's node_modules in every
// ancestor directory, and Interleave binds what Node would load. @prisma/client
// declares optional peers (prisma, typescript), so an ancestor node_modules could
// silently enter the recorded identity. Require a clean ancestry instead.
for (let directory = dirname(evidence); ; directory = dirname(directory)) {
  const found = await lstat(join(directory, 'node_modules')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  assert(!found, `${join(directory, 'node_modules')} is an ancestor of the evidence directory; choose a location without ancestor node_modules`);
  if (dirname(directory) === directory) break;
}
await mkdir(evidence); // Refuse to reuse or overwrite an earlier attempt.

// Official POSIX archives link bin/npm to lib/node_modules/npm/bin/npm-cli.js.
async function toolchainNpm() {
  const bin = dirname(process.execPath);
  for (const candidate of [join(bin, 'npm'), join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    let path;
    try { path = await realpath(candidate); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!path.endsWith([sep + 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep))) continue;
    const { name, version } = JSON.parse(await readFile(join(dirname(dirname(path)), 'package.json'), 'utf8'));
    if (name === 'npm') return { path, version };
  }
  throw new Error(`No npm CLI belongs to the Node.js toolchain in ${bin}`);
}
const npm = await toolchainNpm();

// Copy the example without installed or generated files; the gate installs the
// pinned locks and runs the pinned generator itself.
const example = new URL('../examples/prisma/', import.meta.url);
const app = join(evidence, 'application');
await cp(example, app, { recursive: true, filter: source => !['node_modules', 'generated'].includes(basename(source)) });
await cp(new URL('../test/prisma/functional.mjs', import.meta.url), join(app, 'functional.mjs'));
const originalArchive = join(evidence, 'runtime.tgz'); await cp(archive, originalArchive);
const generator = join(app, 'generator');
const prismaCli = join(generator, 'node_modules', 'prisma', 'build', 'index.js');
const { DATABASE_URL: _unused, ...inherited } = process.env;
const env = { ...inherited, PATH: dirname(process.execPath) + delimiter + process.env.PATH, NODE_OPTIONS: '',
  npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
  // Keep Prisma's engine download cache with the evidence and disable its update checks.
  XDG_CACHE_HOME: join(evidence, 'prisma-cache'), CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: 'true',
  INTERLEAVE_PRISMA_RUNTIME_ARCHIVE: originalArchive, INTERLEAVE_PRISMA_EVIDENCE: evidence, INTERLEAVE_PRISMA_CLI: prismaCli };
const identity = { node: process.version, platform: process.platform, arch: process.arch, npm,
  archive: { source: archive, bytes: archiveBytes.length, sha256: archiveSha256 } };
await mkdir(join(evidence, 'setup'));
let step = 0;
function run(name, args, cwd, timeout = 300_000) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return { name, result };
}
async function setup(name, args, cwd) {
  const { result } = run(name, args, cwd);
  const prefix = join(evidence, 'setup', `${String(++step).padStart(2, '0')}-${name}`);
  await Promise.all([writeFile(prefix + '.json', JSON.stringify({ ...identity, args, cwd: relative(evidence, cwd) || '.', status: result.status,
    signal: result.signal, error: result.error?.message }, null, 2) + '\n'), writeFile(prefix + '.stdout', result.stdout ?? ''), writeFile(prefix + '.stderr', result.stderr ?? '')]);
  assert.equal(result.error, undefined, `${name}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${name} failed: ${result.stderr}`);
  return result.stdout;
}

// Application: the pinned runtime lock plus the Interleave archive under test.
await setup('install-application', [npm.path, 'install', originalArchive, '--ignore-scripts'], app);
// Generation toolchain: its own lock, never installed into the application.
await setup('install-generator', [npm.path, 'ci', '--ignore-scripts'], generator);
await setup('prisma-version', [prismaCli, '--version'], generator);
await setup('prisma-generate', [prismaCli, 'generate'], generator);
const migration = await setup('prisma-migrate-diff', [prismaCli, 'migrate', 'diff', '--from-empty', '--to-schema', '../prisma/schema.prisma', '--script'], generator);
assert.equal(migration, await readFile(join(app, 'prisma/migrations/0_init/migration.sql'), 'utf8'),
  'The committed migration differs from the pinned Prisma CLI output for prisma/schema.prisma');
await setup('typecheck', [join(generator, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '../tsconfig.json'], generator);

// Retain the generated client exactly as recorded evidence refers to it.
async function inventory(root, directory = root) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else { const bytes = await readFile(path); files.push({ path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) }); }
  }
  return files;
}
await writeFile(join(evidence, 'generated-client.json'), JSON.stringify(await inventory(join(app, 'generated')), null, 2) + '\n');
await cp(join(app, 'package-lock.json'), join(evidence, 'installed-package-lock.json'));

const { result } = run('functional', [join(app, 'functional.mjs')], app, 2_400_000);
await Promise.all([writeFile(join(evidence, 'check.json'), JSON.stringify({ ...identity, pid: result.pid, status: result.status,
  signal: result.signal, error: result.error?.message }, null, 2) + '\n'),
writeFile(join(evidence, 'stdout.log'), result.stdout ?? ''), writeFile(join(evidence, 'stderr.log'), result.stderr ?? '')]);
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, 'Prisma functional checks failed; inspect the retained evidence');
