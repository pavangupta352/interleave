import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

// Deliberately separate from the root dependency graph and default test suite.
// An unqualified runtime is an explicit failure, never a skipped test row.
assert(['v22.18.0', 'v24.7.0', 'v26.12.1'].includes(process.version), 'ORM qualification requires Node.js 22.18.0, 24.7.0 or 26.12.1');
const orms = ['sequelize', 'knex', 'mikro-orm'];
const orm = process.env.INTERLEAVE_ORM;
assert(orms.includes(orm), `Set INTERLEAVE_ORM to one of ${orms.join(', ')}`);
assert(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a dedicated PostgreSQL administrator database');
assert(process.env.INTERLEAVE_ORM_RUNTIME_ARCHIVE, 'Set INTERLEAVE_ORM_RUNTIME_ARCHIVE to the Interleave package archive under test');
assert(process.env.INTERLEAVE_ORM_EVIDENCE, 'Set INTERLEAVE_ORM_EVIDENCE to a new evidence directory');
const archive = resolve(process.env.INTERLEAVE_ORM_RUNTIME_ARCHIVE);
const archiveBytes = await readFile(archive);
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
if (process.env.INTERLEAVE_ORM_RUNTIME_SHA256) {
  assert.equal(archiveSha256, process.env.INTERLEAVE_ORM_RUNTIME_SHA256, 'The runtime archive differs from the expected SHA-256');
}
const evidence = resolve(process.env.INTERLEAVE_ORM_EVIDENCE);

// Node resolves a package missing from the application's node_modules in every
// ancestor directory, and Interleave binds what Node would load. Sequelize, Knex
// and @mikro-orm/knex declare optional peers (other database drivers), so an
// ancestor node_modules could silently enter the recorded identity.
for (let directory = dirname(evidence); ; directory = dirname(directory)) {
  const found = await lstat(join(directory, 'node_modules')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  assert(!found, `${join(directory, 'node_modules')} is an ancestor of the evidence directory; choose a location without ancestor node_modules`);
  if (dirname(directory) === directory) break;
}
await mkdir(evidence); // Refuse to reuse or overwrite an earlier attempt.

// Official POSIX archives link bin/npm to lib/node_modules/npm/bin/npm-cli.js.
// Official Windows archives place node_modules/npm beside node.exe.
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

// The application is the example's helper, scenario, manifest and lock; the gate
// installs the lock itself, so the example's own node_modules is never used.
const app = join(evidence, 'application'); await mkdir(app);
const example = new URL(`../examples/${orm}/`, import.meta.url);
for (const file of ['connection.mjs', 'scenario.mjs', 'package.json', 'package-lock.json']) await cp(new URL(file, example), join(app, file));
await cp(new URL('../test/orms/functional.mjs', import.meta.url), join(app, 'functional.mjs'));
const originalArchive = join(evidence, 'runtime.tgz'); await cp(archive, originalArchive);
const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH, NODE_OPTIONS: '',
  npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
  INTERLEAVE_ORM: orm, INTERLEAVE_ORM_RUNTIME_ARCHIVE: originalArchive, INTERLEAVE_ORM_EVIDENCE: evidence };
const identity = { orm, node: process.version, platform: process.platform, arch: process.arch, npm,
  archive: { source: archive, bytes: archiveBytes.length, sha256: archiveSha256 } };

let result = spawnSync(process.execPath, [npm.path, 'install', originalArchive, '--ignore-scripts'],
  { cwd: app, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(evidence, 'install.json'), JSON.stringify({ ...identity, status: result.status, signal: result.signal,
  error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2) + '\n');
assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr);
await cp(join(app, 'package-lock.json'), join(evidence, 'installed-package-lock.json'));

const started = performance.now();
result = spawnSync(process.execPath, [join(app, 'functional.mjs')], { cwd: app, env, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 });
await Promise.all([writeFile(join(evidence, 'check.json'), JSON.stringify({ ...identity, pid: result.pid, status: result.status,
  signal: result.signal, error: result.error?.message, durationMs: Math.round(performance.now() - started) }, null, 2) + '\n'),
writeFile(join(evidence, 'stdout.log'), result.stdout ?? ''), writeFile(join(evidence, 'stderr.log'), result.stderr ?? '')]);
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, `${orm} functional checks failed; inspect the retained evidence`);
