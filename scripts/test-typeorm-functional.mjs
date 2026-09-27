import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

// Deliberately separate from the root dependency graph and default test suite.
// An unqualified runtime is an explicit failure, never a skipped test row.
assert.equal(process.version, 'v22.18.0', 'TypeORM functional qualification requires Node22.18.0');
assert(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a dedicated PostgreSQL administrator database');
assert(process.env.INTERLEAVE_TYPEORM_RUNTIME_ARCHIVE, 'Set INTERLEAVE_TYPEORM_RUNTIME_ARCHIVE to the original Interleave package archive');
assert(process.env.INTERLEAVE_TYPEORM_EVIDENCE, 'Set INTERLEAVE_TYPEORM_EVIDENCE to a new evidence directory');
const archive = resolve(process.env.INTERLEAVE_TYPEORM_RUNTIME_ARCHIVE);
const archiveBytes = await readFile(archive);
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
if (process.env.INTERLEAVE_TYPEORM_RUNTIME_SHA256) {
  assert.equal(archiveSha256, process.env.INTERLEAVE_TYPEORM_RUNTIME_SHA256, 'The runtime archive differs from the expected SHA-256');
}
const evidence = resolve(process.env.INTERLEAVE_TYPEORM_EVIDENCE);
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

// Dependency pins come from the selected example; the helper and scenario are shared.
const example = process.env.INTERLEAVE_TYPEORM_EXAMPLE ?? 'typeorm';
assert(['typeorm', 'typeorm-0.3'].includes(example), 'INTERLEAVE_TYPEORM_EXAMPLE must be typeorm or typeorm-0.3');
const app = join(evidence, 'application'); await mkdir(app);
const shared = new URL('../examples/typeorm/', import.meta.url), pinned = new URL(`../examples/${example}/`, import.meta.url);
for (const file of ['connection.mjs', 'scenario.mjs']) await cp(new URL(file, shared), join(app, file));
for (const file of ['package.json', 'package-lock.json']) await cp(new URL(file, pinned), join(app, file));
await cp(new URL('../test/typeorm/functional.mjs', import.meta.url), join(app, 'functional.mjs'));
const originalArchive = join(evidence, 'runtime.tgz'); await cp(archive, originalArchive);
const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH, NODE_OPTIONS: '',
  npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
  INTERLEAVE_TYPEORM_RUNTIME_ARCHIVE: originalArchive, INTERLEAVE_TYPEORM_EVIDENCE: evidence };
const identity = { example, node: process.version, platform: process.platform, arch: process.arch, npm,
  archive: { source: archive, bytes: archiveBytes.length, sha256: archiveSha256 } };

let result = spawnSync(process.execPath, [npm.path, 'install', originalArchive, '--ignore-scripts'],
  { cwd: app, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(evidence, 'install.json'), JSON.stringify({ ...identity, status: result.status, signal: result.signal,
  error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2) + '\n');
assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr);
await cp(join(app, 'package-lock.json'), join(evidence, 'original-package-lock.json'));

result = spawnSync(process.execPath, [join(app, 'functional.mjs')], { cwd: app, env, encoding: 'utf8', timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
await Promise.all([writeFile(join(evidence, 'check.json'), JSON.stringify({ ...identity, pid: result.pid, status: result.status,
  signal: result.signal, error: result.error?.message }, null, 2) + '\n'),
writeFile(join(evidence, 'stdout.log'), result.stdout ?? ''), writeFile(join(evidence, 'stderr.log'), result.stderr ?? '')]);
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, 'TypeORM functional checks failed; inspect the retained evidence');
