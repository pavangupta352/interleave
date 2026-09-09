import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, posix, resolve } from 'node:path';
import type { SourceIdentity, SourceIdentityDependencies, SourceIdentityPackage } from './source-identity.js';
import { assertInside, assertNoSymlinkComponents, readOrdinaryFile, readRuntimeArchive, safeBundlePath } from './export-archive.js';

export const SHARED_RUNTIME = 'node_modules/@pavangupta352/interleave';
const LIMIT = 16 * 1024 * 1024;
const TOTAL = 128 * 1024 * 1024;
const MAX_PACKAGES = 1000;
const NAME = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;
interface LockedPackage { version: string; resolved: string; integrity: string }
export interface SharedInstallation {
  layout: 'shared-app';
  profile: 'npm-offline-v1';
  runtimePath: 'app/node_modules/@pavangupta352/interleave';
  packages: Array<{ lockPath: string; archive: string }>;
}
export interface SharedArchive { path: string; bytes: Buffer }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[], label: string): Record<string, unknown> {
  const result = object(value, label);
  if (Object.keys(result).sort().join('\0') !== keys.sort().join('\0')) throw new Error(`Invalid ${label} fields`);
  return result;
}
export function parseSharedInstallation(value: unknown): SharedInstallation {
  const obj = exact(value, ['layout', 'profile', 'runtimePath', 'packages'], 'shared installation');
  if (obj.layout !== 'shared-app' || obj.profile !== 'npm-offline-v1' || obj.runtimePath !== `app/${SHARED_RUNTIME}`
      || !Array.isArray(obj.packages) || obj.packages.length < 1 || obj.packages.length > MAX_PACKAGES) throw new Error('Unsupported shared installation profile');
  const packages = obj.packages.map(value => {
    const item = exact(value, ['lockPath', 'archive'], 'shared archive binding');
    const lockPath = safeBundlePath(item.lockPath, 'Locked package path');
    const archive = safeBundlePath(item.archive, 'Archive path');
    if (!/^archives\/[a-f0-9]{64}\.tgz$/.test(archive)) throw new Error('Shared archive must use its content hash filename');
    return { lockPath, archive };
  });
  if (packages.some((item, i) => i > 0 && packages[i - 1]!.lockPath >= item.lockPath)) throw new Error('Shared lock paths must be unique and sorted');
  return { layout: 'shared-app', profile: 'npm-offline-v1', runtimePath: `app/${SHARED_RUNTIME}`, packages };
}

function lockedPackages(lockBytes: Buffer): Map<string, LockedPackage> {
  const lock = object(JSON.parse(lockBytes.toString('utf8')), 'original application lock');
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) throw new Error('Shared export supports npm lock formats 2 and 3');
  const result = new Map<string, LockedPackage>();
  for (const [path, raw] of Object.entries(object(lock.packages, 'lock packages')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!path) continue;
    safeBundlePath(path, 'Locked package path');
    if (!/^(?:node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)(?:\/node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)*$/.test(path)) throw new Error('Shared export requires ordinary npm node_modules lock paths');
    const node = object(raw, 'locked package');
    if (node.link || node.inBundle || node.hasInstallScript) throw new Error(`Shared offline export does not support linked, bundled, or install-script packages: ${path}`);
    if (typeof node.version !== 'string' || typeof node.resolved !== 'string' || typeof node.integrity !== 'string') throw new Error(`Missing original archive binding: ${path}`);
    // One strong canonical SRI profile avoids ambiguities in multi-digest fallback.
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(node.integrity)) throw new Error(`Shared export requires one SHA-512 original archive integrity: ${path}`);
    result.set(path, { version: node.version, resolved: node.resolved, integrity: node.integrity });
    if (result.size > MAX_PACKAGES) throw new Error('Shared export exceeds 1000 locked packages');
  }
  if (!result.has(SHARED_RUNTIME)) throw new Error('Shared export requires a top-level app-installed Interleave runtime in the original lock');
  return result;
}

function graphMapping(source: SourceIdentity, locked: Map<string, LockedPackage>): Map<string, SourceIdentityPackage[]> {
  const byPath = new Map<string, SourceIdentityPackage[]>();
  const locate = (specifier: string, from: string): string | undefined => {
    // Source roots retain the full import, such as drizzle-orm/node-postgres.
    // npm lock paths identify the owning package; keep the recorded edge intact.
    const parts = specifier.split('/');
    const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    if (!NAME.test(name) || Buffer.byteLength(specifier) > 4096 || /[:\\\u0000-\u001f\u007f]/.test(specifier)
      || specifier.startsWith('.') || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsupported dependency name in shared graph');
    let current = from;
    while (true) {
      const candidate = posix.join(current, 'node_modules', name);
      if (posix.basename(current) !== 'node_modules' && locked.has(candidate)) return candidate;
      if (current === '.' || current === '') return undefined;
      current = posix.dirname(current);
    }
  };
  const map = (graph: SourceIdentityDependencies, root: string, app: boolean) => {
    const paths = new Map<string, string>();
    const reverse = new Map<string, string>();
    const visit = (edge: SourceIdentityDependencies['roots'][number], from: string) => {
      const path = locate(edge.name, from);
      if (edge.missing) { if (path) throw new Error('Original lock installs a historically missing optional package'); return; }
      if (!path || !edge.packageId) throw new Error('Original lock cannot preserve the recorded dependency graph');
      if (paths.has(edge.packageId)) { if (paths.get(edge.packageId) !== path) throw new Error('Original lock splits a recorded shared package instance'); return; }
      if (reverse.has(path)) throw new Error('Original lock merges distinct recorded package instances');
      paths.set(edge.packageId, path); reverse.set(path, edge.packageId);
      const node = graph.packages.find(node => node.id === edge.packageId);
      if (!node || node.version !== locked.get(path)!.version) throw new Error('Original lock package version differs from the recorded graph');
      byPath.set(path, [...byPath.get(path) ?? [], node]);
      for (const child of node.dependencies) visit(child, path);
    };
    for (const edge of graph.roots) visit(edge, app ? posix.dirname(edge.from ?? source.entry) : root);
    if (paths.size !== graph.packages.length) throw new Error('Recorded dependency graph contains unreachable packages');
    return paths;
  };
  const app = map(source.components.dependencies, '.', true);
  const runtime = map(source.components.runtime.dependencies, SHARED_RUNTIME, false);
  const candidates = source.components.dependencies.packages.filter(node => node.name === '@pavangupta352/interleave');
  // A plain-object scenario need not import the runtime API. Its installed CLI
  // is still bound by the top-level lock, runtime files and original archive.
  if (candidates.length > 1 || (candidates.length === 1 && app.get(candidates[0]!.id) !== SHARED_RUNTIME)) throw new Error('Shared export requires any application runtime import to resolve to the top-level Interleave package');
  const shared = [...app].flatMap(([dependencyPackageId, path]) => [...runtime].filter(([, other]) => other === path).map(([runtimePackageId]) => ({ dependencyPackageId, runtimePackageId })))
    .sort((a, b) => a.dependencyPackageId < b.dependencyPackageId ? -1 : a.dependencyPackageId > b.dependencyPackageId ? 1 : a.runtimePackageId < b.runtimePackageId ? -1 : a.runtimePackageId > b.runtimePackageId ? 1 : 0);
  if (stable(shared) !== stable(source.sharedPackages)) throw new Error('Original lock does not preserve the recorded shared package topology');
  return byPath;
}

export function verifySharedArchives(lockBytes: Buffer, source: SourceIdentity, installation: SharedInstallation, archives: Map<string, Buffer>): void {
  const locked = lockedPackages(lockBytes);
  const mapping = graphMapping(source, locked);
  if (stable(installation.packages.map(item => item.lockPath)) !== stable([...locked.keys()])) throw new Error('Shared archive bindings do not match the original application lock');
  const used = new Set<string>(); let total = 0, files = 0;
  const parsed = new Map<string, Map<string, Buffer>>();
  for (const binding of installation.packages) {
    const data = archives.get(binding.archive);
    if (!data || binding.archive !== `archives/${hash(data)}.tgz`) throw new Error('Missing or incorrectly named shared archive');
    if (`sha512-${createHash('sha512').update(data).digest('base64')}` !== locked.get(binding.lockPath)!.integrity) throw new Error(`Original locked archive integrity mismatch: ${binding.lockPath}`);
    used.add(binding.archive);
    let archive = parsed.get(binding.archive);
    if (!archive) {
      archive = readRuntimeArchive(data); parsed.set(binding.archive, archive);
      total += data.length + [...archive.values()].reduce((sum, bytes) => sum + bytes.length, 0); files += archive.size;
      if (total > TOTAL || files > 10_000) throw new Error('Shared archives exceed 128 MiB or 10000 expanded files');
    }
    const metadata = object(JSON.parse(archive.get('package.json')?.toString('utf8') ?? 'null'), 'archive package metadata');
    for (const key of ['bundledDependencies', 'bundleDependencies']) if (metadata[key] !== undefined && metadata[key] !== false && !(Array.isArray(metadata[key]) && metadata[key].length === 0)) throw new Error('Bundled dependency archives are unsupported');
    const scripts = object(metadata.scripts ?? {}, 'package scripts');
    if (['preinstall', 'install', 'postinstall'].some(name => Object.hasOwn(scripts, name)) || archive.has('binding.gyp')) throw new Error('Install-script and native build packages are unsupported by shared offline export');
    if (metadata.version !== locked.get(binding.lockPath)!.version) throw new Error('Archive metadata differs from its original lock version');
    const records = [...archive].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const node of mapping.get(binding.lockPath) ?? []) {
      if (node.name !== metadata.name || stable(records) !== stable(node.files)) throw new Error(`Archive does not match recorded package bytes: ${binding.lockPath}`);
    }
  }
  if (used.size !== archives.size) throw new Error('Shared export contains an unbound archive');
}

async function explicitArchive(path: string): Promise<Buffer> {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError('Archive must be an explicit ordinary file path');
  const absolute = resolve(path); await assertNoSymlinkComponents(parse(absolute).root, absolute);
  return readOrdinaryFile(absolute, LIMIT);
}
/** @internal Bounded official-registry archive transport; never follows redirects. */
export async function fetchRegistryArchive(url: string, remaining: number): Promise<Buffer> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Unsupported archive source; supply an explicit dependencyArchive'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith('.tgz')) throw new Error('Only locked HTTPS registry.npmjs.org tarballs can be fetched; supply an explicit archive for this source');
  return new Promise((resolveBytes, reject) => {
    const request = get(parsed, { headers: { accept: 'application/octet-stream' } }, response => {
      if (response.statusCode !== 200) {
        reject(new Error('Locked registry archive unavailable or redirected; supply its original archive explicitly'));
        response.destroy(); request.destroy(); return;
      }
      const chunks: Buffer[] = []; let size = 0, finished = false;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > LIMIT) { reject(new Error('Archive download exceeds 16 MiB')); response.destroy(); request.destroy(); }
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Archive response was aborted before completion')));
      response.once('close', () => { if (!finished) reject(new Error('Archive response closed before completion')); });
      response.once('end', () => { finished = true; resolveBytes(Buffer.concat(chunks)); });
    });
    const timer = setTimeout(() => request.destroy(new Error('Archive acquisition deadline exceeded')), Math.min(30_000, remaining));
    request.once('error', reject); request.once('close', () => clearTimeout(timer));
  });
}

export async function prepareSharedArchives(options: { projectRoot: string; runtimeRoot: string; runtimeArchive?: string; dependencyArchives?: string[] }, source: SourceIdentity, lock: Buffer): Promise<{ installation: SharedInstallation; archives: SharedArchive[]; runtimeArchive: SharedArchive }> {
  const expected = join(options.projectRoot, ...SHARED_RUNTIME.split('/'));
  if (expected !== options.runtimeRoot) throw new Error('Shared instances require the same top-level app-installed runtime; separate installations cannot preserve them');
  await assertNoSymlinkComponents(options.projectRoot, expected);
  if (await realpath(expected) !== options.runtimeRoot) throw new Error('Shared instances require the same top-level app-installed runtime; separate installations cannot preserve them');
  for (const path of ['.npmrc', 'npm-shrinkwrap.json']) if (await lstat(join(options.projectRoot, path)).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error(`Shared export does not support application ${path}; use a plain npm package-lock profile`);
  const locked = lockedPackages(lock); graphMapping(source, locked);
  if (options.dependencyArchives !== undefined && (!Array.isArray(options.dependencyArchives) || options.dependencyArchives.length > MAX_PACKAGES || options.dependencyArchives.some(path => typeof path !== 'string'))) throw new TypeError('dependencyArchives must be a bounded array of ordinary archive paths');
  const provided = new Map<string, Buffer>(); let acquired = 0; const deadline = Date.now() + 120_000;
  const add = (bytes: Buffer) => { acquired += bytes.length; if (acquired > TOTAL) throw new Error('Shared archive acquisition exceeds 128 MiB'); provided.set(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, bytes); };
  for (const path of options.dependencyArchives ?? []) add(await explicitArchive(path));
  const accepted = new Set([...locked.values()].map(node => node.integrity));
  if ([...provided.keys()].some(integrity => !accepted.has(integrity))) throw new Error('Unused explicit dependency archive does not match the original lock');
  if (options.runtimeArchive !== undefined) {
    const bytes = await explicitArchive(options.runtimeArchive); add(bytes);
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== locked.get(SHARED_RUNTIME)!.integrity) throw new Error('Original locked archive integrity mismatch for runtimeArchive');
  }
  const archives = new Map<string, Buffer>(); const packages: SharedInstallation['packages'] = [];
  for (const [lockPath, node] of locked) {
    if (Date.now() >= deadline) throw new Error('Shared archive acquisition deadline exceeded');
    let bytes = provided.get(node.integrity);
    if (!bytes && node.resolved.startsWith('file:')) {
      const path = node.resolved.slice(5);
      if (isAbsolute(path) || !path.endsWith('.tgz')) throw new Error('Original local archive unavailable; supply runtimeArchive or dependencyArchives explicitly');
      const absolute = resolve(options.projectRoot, path);
      try { assertInside(options.projectRoot, absolute, 'Locked local archive'); bytes = await readOrdinaryFile(absolute, LIMIT, options.projectRoot); }
      catch (error) { throw new Error('Original local archive unavailable; supply runtimeArchive or dependencyArchives explicitly', { cause: error }); }
    }
    if (!bytes) bytes = await fetchRegistryArchive(node.resolved, deadline - Date.now());
    if (!provided.has(node.integrity)) add(bytes);
    const path = `archives/${hash(bytes)}.tgz`; archives.set(path, bytes); packages.push({ lockPath, archive: path });
  }
  const installation: SharedInstallation = { layout: 'shared-app', profile: 'npm-offline-v1', runtimePath: `app/${SHARED_RUNTIME}`, packages };
  verifySharedArchives(lock, source, installation, archives);
  const selected = packages.find(item => item.lockPath === SHARED_RUNTIME)!;
  return { installation, archives: [...archives].map(([path, bytes]) => ({ path, bytes })), runtimeArchive: { path: selected.archive, bytes: archives.get(selected.archive)! } };
}
