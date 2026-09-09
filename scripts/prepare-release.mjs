#!/usr/bin/env node
// Prepares evidence only. It never creates a Git tag, release, or npm publication.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readOrdinaryFile } from '../src/export-archive.ts';
import { inspectPackageArchive, integrity, sha256, validatePackageMetadata, validateSourcePaths } from './release-archive.mjs';

const repositoryDefault = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_SOURCE = 128 * 1024 * 1024;
const environment = () => ({ PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function assert(condition, message) { if (!condition) throw new Error(message); }

async function command(executable, args, { cwd, env = environment(), timeout = 180_000, maximum = 2 * 1024 * 1024, signal } = {}) {
  signal?.throwIfAborted();
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const stdout = [], stderr = []; let bytes = 0, failure;
    const stop = error => {
      failure ??= error;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') child.kill('SIGKILL'); } }
    };
    const onAbort = () => stop(new Error('Release preparation interrupted'));
    const timer = setTimeout(() => stop(new Error(`Release preparation command timed out: ${basename(executable)}`)), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maximum) stop(new Error(`Release preparation command output exceeded its bound: ${basename(executable)}`));
      else chunks.push(chunk);
    });
    child.once('error', error => { failure ??= error; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Release preparation command failed (${basename(executable)}, exit ${code}): ${Buffer.concat(stderr).toString('utf8').slice(-2000)}`));
      else resolveCommand(Buffer.concat(stdout));
    });
  });
}
const git = (repository, args, options = {}) => command('git', ['-C', repository, ...args], options);
const gitText = async (repository, args, options) => (await git(repository, args, options)).toString('utf8').trim();

export async function resolveReleaseSource(repository, { ref, tag, signal } = {}) {
  assert(process.platform !== 'win32', 'Release preparation currently requires a POSIX Git/tar/npm environment');
  assert(Boolean(ref) !== Boolean(tag), 'Specify exactly one immutable --ref commit or existing --tag');
  if (ref) assert(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(ref), '--ref must be a full immutable Git commit hash');
  if (tag) assert(/^v[0-9][a-z0-9.+-]*$/i.test(tag), 'Invalid version tag');
  const selected = tag ? `refs/tags/${tag}` : ref;
  let commit, object;
  try {
    commit = await gitText(repository, ['rev-parse', '--verify', `${selected}^{commit}`], { signal });
    object = await gitText(repository, ['rev-parse', '--verify', selected], { signal });
  } catch { throw new Error('Selected commit or existing version tag could not be resolved'); }
  if (ref) assert(commit === ref && object === ref, '--ref must identify the commit itself');
  return { commit, tree: await gitText(repository, ['rev-parse', `${commit}^{tree}`], { signal }), tag: tag ?? null, tagObject: tag ? object : null };
}

async function sourceEntries(repository, commit, signal) {
  const raw = await git(repository, ['ls-tree', '-r', '-z', '--full-tree', commit], { signal });
  const entries = raw.toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line);
    assert(match, 'Unsupported source tree entry');
    return { path: match[4], mode: match[1], object: match[3] };
  });
  validateSourcePaths(entries);
  return entries;
}

async function treeFiles(directory, relative = '', collected = []) {
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await treeFiles(directory, path, collected);
    else { assert(entry.isFile(), `Extracted source has a non-ordinary file: ${path}`); collected.push(path); }
    assert(collected.length <= 10_000, 'Extracted source exceeds its file count bound');
  }
  return collected;
}

async function verifySource(directory, entries, algorithm) {
  const actual = (await treeFiles(directory)).sort();
  assert(JSON.stringify(actual) === JSON.stringify(entries.map(entry => entry.path).sort()), 'Source archive does not contain the complete selected Git tree');
  let total = 0;
  for (const entry of entries) {
    const path = join(directory, entry.path); const bytes = await readOrdinaryFile(path, 16 * 1024 * 1024, directory);
    total += bytes.length; assert(total <= MAX_SOURCE, 'Source archive exceeds its total byte bound');
    const object = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert(object === entry.object, `Source archive bytes differ from Git: ${entry.path}`);
    assert(Boolean((await lstat(path)).mode & 0o111) === (entry.mode === '100755'), `Source executable mode differs from Git: ${entry.path}`);
  }
}

async function inspectExtractedPackage(directory, files) {
  const actual = (await treeFiles(directory)).sort();
  assert(JSON.stringify(actual) === JSON.stringify([...files.keys()].sort()), 'Extracted package file inventory differs from its inspected archive');
  const modes = new Map();
  for (const [path, bytes] of files) {
    const fullPath = join(directory, path);
    assert((await readOrdinaryFile(fullPath, 16 * 1024 * 1024, directory)).equals(bytes), `Extracted package bytes differ: ${path}`);
    const mode = (await lstat(fullPath)).mode & 0o777;
    assert((mode & 0o022) === 0, `Package is writable by another account: ${path}`);
    modes.set(path, mode.toString(8).padStart(3, '0'));
  }
  assert(modes.get('dist/cli.js') === '755', 'Packaged CLI must preserve executable mode 755');
  return modes;
}

async function buildPackage(context, label) {
  const { scratch, sourceArchive, entries, algorithm, metadata, lockBytes, env, signal } = context;
  const cwd = join(scratch, label); await mkdir(cwd);
  await command('tar', ['-xzf', sourceArchive, '--strip-components=1', '-C', cwd], { env, signal });
  await verifySource(cwd, entries, algorithm);
  console.error(`[release] ${label}: installing the locked graph and building selected source.`);
  await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev', '--include=optional'], { cwd, env, signal });
  assert((await readOrdinaryFile(join(cwd, 'package-lock.json'))).equals(lockBytes), 'Locked install changed the source lockfile');
  await command('npm', ['run', 'build'], { cwd, env, signal });
  assert((await readOrdinaryFile(join(cwd, 'package-lock.json'))).equals(lockBytes), 'Build changed the source lockfile');
  const pack = JSON.parse((await command('npm', ['pack', '--ignore-scripts', '--json'], { cwd, env, signal })).toString('utf8'));
  const filename = `pavangupta352-interleave-${metadata.version}.tgz`;
  assert(pack.length === 1 && pack[0].filename === filename, 'npm returned an unexpected package filename');
  const path = join(cwd, filename), bytes = await readOrdinaryFile(path, MAX_ARCHIVE, cwd);
  const inspected = inspectPackageArchive(bytes, metadata);
  assert(pack[0].integrity === inspected.integrity, 'npm pack integrity differs from actual archive bytes');
  for (const entry of entries) {
    if (!entry.path.startsWith('src/') || !entry.path.endsWith('.ts')) continue;
    const stem = `dist/${entry.path.slice(4, -3)}`;
    for (const extension of ['.js', '.js.map', '.d.ts', '.d.ts.map']) assert(inspected.files.has(stem + extension), `Package omitted compiled source output: ${stem + extension}`);
  }
  const extracted = join(scratch, `${label}-package`); await mkdir(extracted);
  await command('tar', ['-xzf', path, '--strip-components=1', '-C', extracted], { env, signal });
  const modes = await inspectExtractedPackage(extracted, inspected.files);
  // Complete source-owned docs/examples and copied license/provenance files must
  // survive npm selection. Generated dist is compared by the second clean build.
  for (const entry of entries) {
    if (entry.path !== 'package.json' && !metadata.files.includes(entry.path.split('/')[0])) continue;
    const source = await readOrdinaryFile(join(cwd, entry.path));
    assert(inspected.files.get(entry.path)?.equals(source), `Package omitted or changed selected source file: ${entry.path}`);
  }
  return { path, bytes, filename, ...inspected, inventory: inspected.inventory.map(entry => ({ ...entry, mode: modes.get(entry.path) })) };
}

async function acceptInstalled(context, archive, packageHash) {
  const cwd = join(context.scratch, 'installed consumer with spaces'); await mkdir(cwd);
  await writeFile(join(cwd, 'package.json'), json({ name: 'interleave-release-acceptance', version: '1.0.0', private: true, type: 'module' }));
  const localArchive = join(cwd, 'candidate.tgz'); await writeFile(localArchive, archive, { flag: 'wx' });
  console.error('[release] Installing and checking the exact candidate archive in a fresh consumer.');
  const options = { cwd, env: { ...context.env, npm_config_cache: join(context.scratch, 'consumer-cache') }, signal: context.signal };
  await command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', './candidate.tgz'], options);
  const installed = join(cwd, 'node_modules/@pavangupta352/interleave');
  const metadata = JSON.parse(await readOrdinaryFile(join(installed, 'package.json')));
  assert(metadata.version === context.metadata.version, 'Installed package version differs from the candidate');
  const inspected = inspectPackageArchive(archive, context.metadata);
  for (const [path, bytes] of inspected.files) assert((await readOrdinaryFile(join(installed, path), 16 * 1024 * 1024, installed)).equals(bytes), `Installed package differs from candidate: ${path}`);
  await command(process.execPath, ['--input-type=module', '--eval', "import{defineScenario,runOnce}from'@pavangupta352/interleave';if(typeof defineScenario!=='function'||typeof runOnce!=='function')throw Error('Public ESM exports missing');"], options);
  const cli = join(cwd, 'node_modules/.bin/interleave');
  assert((await command(cli, ['--version'], options)).toString('utf8').trim() === context.metadata.version, 'Installed CLI returned a different version');
  assert(/Interleave/i.test((await command(cli, ['--help'], options)).toString('utf8')), 'Installed CLI help is missing');
  const scaffold = join(cwd, 'new scenario'); await command(cli, ['init', scaffold], options);
  const scaffoldPackage = JSON.parse(await readOrdinaryFile(join(scaffold, 'package.json')));
  assert(scaffoldPackage.dependencies?.[context.metadata.name] === context.metadata.version, 'Installed init selected a different package version');
  for (const path of ['scenario.mjs', 'README.md']) assert((await readOrdinaryFile(join(scaffold, path))).length > 0, `Installed init omitted ${path}`);
  const lockBytes = await readOrdinaryFile(join(cwd, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  assert(lock.packages?.['node_modules/@pavangupta352/interleave']?.integrity === integrity(archive), 'Consumer lock does not bind the installed candidate archive');
  return { lockBytes, result: { installedArchiveSha256: packageHash, import: true, cliVersion: true, cliHelp: true, init: true, database: 'not-run' } };
}

function qualificationContext(source, env) {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  assert(env.GITHUB_REPOSITORY === 'pavangupta352/interleave' && /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'Invalid GitHub qualification context');
  assert(source.tag && env.GITHUB_REF === `refs/tags/${source.tag}` && env.GITHUB_SHA === source.commit, 'GitHub run does not match the selected version tag commit');
  let needs; try { needs = JSON.parse(env.INTERLEAVE_RELEASE_NEEDS); } catch { throw new Error('Required CI job conclusions are missing'); }
  for (const job of ['postgres', 'pgvector', 'browser']) assert(needs?.[job]?.result === 'success', `Required CI job family did not succeed: ${job}`);
  return { kind: 'github-actions-needs', runUrl: `https://github.com/pavangupta352/interleave/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
    commit: source.commit, jobFamilies: { postgres: 'success', pgvector: 'success', browser: 'success' },
    scope: 'Existing nine-job matrix using its own source checkouts and builds. Candidate archive acceptance here is the installed smoke only.' };
}

export async function prepareRelease({ repository = repositoryDefault, ref, tag, out, archive, signal, qualificationEnvironment = {} }) {
  assert(typeof out === 'string' && out.length > 0, 'A new --out directory is required');
  out = resolve(out); repository = resolve(repository);
  try { await lstat(out); throw new Error('Release output already exists; choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = await resolveReleaseSource(repository, { ref, tag, signal });
  const metadataBytes = await git(repository, ['show', `${source.commit}:package.json`], { signal });
  const lockBytes = await git(repository, ['show', `${source.commit}:package-lock.json`], { signal });
  const metadata = JSON.parse(metadataBytes), lock = JSON.parse(lockBytes);
  validatePackageMetadata(metadata, lock, source.tag);
  const qualification = qualificationContext(source, qualificationEnvironment);
  // Inspect user-supplied bytes before installing or executing source; after the
  // two builds they must also match the unmodified original npm pack bytes.
  const supplied = archive ? await readOrdinaryFile(resolve(archive), MAX_ARCHIVE) : undefined;
  if (supplied) inspectPackageArchive(supplied, metadata);
  const entries = await sourceEntries(repository, source.commit, signal);
  const algorithm = await gitText(repository, ['rev-parse', '--show-object-format'], { signal });
  assert(['sha1', 'sha256'].includes(algorithm), 'Unsupported Git object hash algorithm');
  const scratch = await mkdtemp(join(tmpdir(), 'interleave release '));
  try {
    const env = { ...environment(), TMPDIR: join(scratch, 'tmp'),
      npm_config_cache: join(scratch, 'build-cache'), npm_config_userconfig: join(scratch, 'npmrc'), npm_config_globalconfig: join(scratch, 'global-npmrc') };
    await mkdir(env.TMPDIR);
    for (const path of [env.npm_config_userconfig, env.npm_config_globalconfig]) await writeFile(path, '');
    const npm = (await command('npm', ['--version'], { env, signal })).toString('utf8').trim();
    assert(/^\d+\.\d+\.\d+$/.test(npm), 'Could not identify npm version');
    const tools = { node: process.versions.node, npm, platform: process.platform, architecture: process.arch };
    const sourceBytes = gzipSync(await git(repository, ['-c', 'tar.umask=0022', 'archive', '--format=tar', '--prefix=interleave-source/', source.commit], { signal, maximum: MAX_SOURCE }));
    assert(sourceBytes.length <= MAX_ARCHIVE, 'Source archive exceeds the compressed byte bound');
    const sourceArchive = join(scratch, 'source.tar.gz'); await writeFile(sourceArchive, sourceBytes);
    const context = { scratch, sourceArchive, entries, algorithm, metadata, lockBytes, env, signal };
    const first = await buildPackage(context, 'build-one');
    const second = await buildPackage(context, 'build-two');
    assert(first.bytes.equals(second.bytes) && JSON.stringify(first.inventory) === JSON.stringify(second.inventory), 'Clean builds produced different package bytes or modes; candidate is not reproducible');
    if (supplied) assert(supplied.equals(first.bytes), 'Supplied archive differs from the original reproducible package bytes');
    const candidate = supplied ?? first.bytes;
    const acceptance = await acceptInstalled(context, candidate, first.sha256);
    const sourceFilename = `interleave-${metadata.version}-source.tar.gz`;
    const manifest = { schemaVersion: 1, status: 'prepared-only', package: { name: metadata.name, version: metadata.version, filename: first.filename, bytes: candidate.length, sha256: first.sha256, integrity: first.integrity },
      source: { ...source, filename: sourceFilename, bytes: sourceBytes.length, sha256: sha256(sourceBytes), lockSha256: sha256(lockBytes) }, tools,
      reproducibility: { cleanBuilds: 2, packageBytesEqual: true, scope: 'Same recorded Node/npm/platform and committed lock. No cross-platform equality claim.' },
      acceptance: acceptance.result, consumerLock: { filename: 'consumer-package-lock.json', sha256: sha256(acceptance.lockBytes) }, qualification,
      files: first.inventory,
      limits: ['Prepared assets only; no tag, release, registry publication or authentication was performed.', 'Historical qualifications and final publication acceptance remain separate required gates.', 'Installed smoke covers import/help/version/init; no candidate-archive database, browser or registry-download qualification is claimed.', 'Checksums record byte agreement; no signature, attestation or exhaustive secret detection is claimed.', 'A prepared-only manifest alone is not sufficient. Run --verify on the complete asset directory before using it.'] };
    signal?.throwIfAborted();
    await mkdir(out);
    try {
      const ownership = await lstat(out);
      const checkOutput = async () => {
        signal?.throwIfAborted();
        const current = await lstat(out);
        assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === ownership.dev && current.ino === ownership.ino,
          'Release output changed ownership while being written');
      };
      for (const [path, bytes] of [[first.filename, candidate], [sourceFilename, sourceBytes], ['consumer-package-lock.json', acceptance.lockBytes], ['release-manifest.json', Buffer.from(json(manifest))]]) {
        await checkOutput();
        await writeFile(join(out, path), bytes, { flag: 'wx', mode: 0o644 });
      }
      const paths = [first.filename, sourceFilename, 'consumer-package-lock.json', 'release-manifest.json'].sort();
      const checksums = [];
      for (const path of paths) {
        await checkOutput();
        checksums.push(`${sha256(await readOrdinaryFile(join(out, path), MAX_ARCHIVE, out))}  ${path}`);
      }
      await checkOutput();
      await writeFile(join(out, 'SHA256SUMS'), `${checksums.join('\n')}\n`, { flag: 'wx', mode: 0o644 });
      await checkOutput();
      await verifyPreparedAssets(out);
      await checkOutput();
      return manifest;
    } catch (error) {
      // A path can change after a check. Preserve all uncertain output, as the
      // exporter does, instead of deleting or replacing someone else's files.
      throw new Error(`${error.message}\nIncomplete release output preserved at ${out}. Inspect this folder; it may have changed ownership. Run --verify on the complete asset directory before using it.`, { cause: error });
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function verifyPreparedAssets(directory) {
  const checksums = (await readOrdinaryFile(join(directory, 'SHA256SUMS'))).toString('utf8').trim().split('\n');
  assert(checksums.length === 4, 'Unexpected release checksum inventory');
  const seen = new Set();
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9][a-zA-Z0-9.+-]*)$/.exec(line);
    assert(match && !seen.has(match[2]), 'Invalid release checksum filename'); seen.add(match[2]);
    assert(sha256(await readOrdinaryFile(join(directory, match[2]), MAX_ARCHIVE, directory)) === match[1], `Release checksum mismatch: ${match[2]}`);
  }
  const assetPaths = (await readdir(directory)).sort();
  assert(JSON.stringify(assetPaths) === JSON.stringify([...seen, 'SHA256SUMS'].sort()), 'Unexpected release asset inventory');
  const manifest = JSON.parse(await readOrdinaryFile(join(directory, 'release-manifest.json')));
  assert(manifest.schemaVersion === 1 && manifest.status === 'prepared-only', 'Unsupported release manifest');
  assert(seen.has(manifest.package.filename) && seen.has(manifest.source.filename) && seen.has(manifest.consumerLock.filename) && seen.has('release-manifest.json'), 'Release manifest disagrees with checksum inventory');
  const bytes = await readOrdinaryFile(join(directory, manifest.package.filename), MAX_ARCHIVE);
  assert(sha256(bytes) === manifest.package.sha256 && integrity(bytes) === manifest.package.integrity, 'Package hash differs from release manifest');
  assert(sha256(await readOrdinaryFile(join(directory, manifest.source.filename), MAX_ARCHIVE)) === manifest.source.sha256, 'Source hash differs from release manifest');
  assert(sha256(await readOrdinaryFile(join(directory, manifest.consumerLock.filename))) === manifest.consumerLock.sha256, 'Consumer lock hash differs from release manifest');
  return manifest;
}

async function main(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    assert(['--ref', '--tag', '--out', '--archive', '--verify'].includes(flag) && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('--') && !Object.hasOwn(values, flag), 'Usage: node scripts/prepare-release.mjs (--ref <full-commit> | --tag <existing-tag>) --out <new-directory> [--archive <tarball>] | --verify <downloaded-directory>');
    values[flag] = args[index + 1];
  }
  if (values['--verify']) {
    assert(Object.keys(values).length === 1, '--verify cannot be combined with preparation options');
    await verifyPreparedAssets(resolve(values['--verify'])); console.log('Prepared asset checksums verified.'); return;
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const manifest = await prepareRelease({ ref: values['--ref'], tag: values['--tag'], out: values['--out'], archive: values['--archive'], signal: controller.signal, qualificationEnvironment: process.env });
    console.log(`Prepared ${manifest.package.name}@${manifest.package.version} from ${manifest.source.commit}. No publication performed.`);
  } finally { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`[release] ${error.message}`); process.exitCode = 1; });
}
