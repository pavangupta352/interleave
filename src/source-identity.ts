import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SourceDependency } from './export-source.js';

export interface CaptureSourceIdentityOptions {
  projectRoot?: string;
  include?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxFiles?: number;
  maxBytes?: number;
}
export interface SourceIdentityFile { path: string; bytes: number; sha256: string }
export interface SourceIdentityFiles { fingerprint: string; files: SourceIdentityFile[]; fileCount: number; byteCount: number }
export interface SourceIdentityDependency { name: string; from?: string; packageId?: string; optional?: true; missing?: true }
export interface SourceIdentityPackage extends SourceIdentityFiles { id: string; name: string; version: string; dependencies: SourceIdentityDependency[] }
export interface SourceIdentityDependencies { fingerprint: string; roots: SourceIdentityDependency[]; packages: SourceIdentityPackage[]; fileCount: number; byteCount: number }
export interface SourceIdentityRuntime extends SourceIdentityFiles { mode: 'source' | 'build'; dependencies: SourceIdentityDependencies }
export interface SourceIdentity {
  version: 1;
  profile: 'node-source-v1';
  algorithm: 'sha256';
  fingerprint: string;
  entry: string;
  includes: string[];
  sharedPackages: Array<{ dependencyPackageId: string; runtimePackageId: string }>;
  components: { source: SourceIdentityFiles; dependencies: SourceIdentityDependencies; runtime: SourceIdentityRuntime };
  fileCount: number;
  byteCount: number;
}
export class SourceIdentityError extends Error {
  constructor(readonly kind: 'unsupported' | 'budget' | 'aborted' | 'changed' | 'io', message: string, options?: ErrorOptions) { super(message, options); this.name = 'SourceIdentityError'; }
}
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;
const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const PACKAGE_NAME = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;
type Json = Record<string, unknown>;
interface CachedFile { bytes: Buffer; stats: Stats; root: string }
interface DependencyRequest { name: string; from: string; importer?: string; optional?: true }

/** Read a portable selected-source, installed-package, and runtime identity.
 * No application/dependency module is imported and no package script is run.
 */
export async function captureSourceIdentity(scenarioFile: string, options: CaptureSourceIdentityOptions = {}): Promise<SourceIdentity> {
  return captureIdentity(scenarioFile, options);
}

/** @internal Read a selected built runtime for export comparison without
 * importing it. Normal run capture always binds the executing runtime.
 */
export async function captureExportSourceIdentity(scenarioFile: string, options: CaptureSourceIdentityOptions, runtimeRoot: string): Promise<SourceIdentity> {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot) unsupported('Export capture requires a built runtimeRoot');
  return captureIdentity(scenarioFile, options, runtimeRoot);
}

async function captureIdentity(scenarioFile: string, options: CaptureSourceIdentityOptions, builtRuntimeRoot?: string): Promise<SourceIdentity> {
  const state = new CaptureState(options);
  try {
    return await state.run(async () => {
      const requestedEntry = resolvePath(scenarioFile, 'scenarioFile');
      const requestedRoot = options.projectRoot === undefined
        ? await nearestProjectRoot(dirname(requestedEntry), state)
        : resolvePath(options.projectRoot, 'projectRoot');
      inside(requestedRoot, requestedEntry);
      await noSymlinks(requestedRoot, requestedEntry, state);
      const root = await ordinaryDirectory(requestedRoot, state);
      const entry = await realpath(requestedEntry);
      inside(root, entry);
      const includes = normalizeIncludes(options.include, state.maxFiles);
      const source = new Map<string, SourceIdentityFile>();
      const imports: DependencyRequest[] = [];
      const visited = new Set<string>();
      const addSource = async (path: string) => {
        const bytes = await state.read(root, path);
        source.set(portable(root, path), record(portable(root, path), bytes));
        return bytes;
      };
      const scope = async (path: string) => {
        let directory = dirname(path);
        let found = false;
        let nearest: Json | undefined;
        while (true) {
          const metadata = join(directory, 'package.json');
          if (await state.exists(metadata)) {
            const bytes = await addSource(metadata); found = true;
            nearest ??= object(bytes, 'Local package metadata');
          }
          if (directory === root) break;
          inside(root, directory);
          directory = dirname(directory);
        }
        if (!found && root !== dirname(root)) {
          const enclosing = await nearestProjectRoot(dirname(root), state);
          if (await state.exists(join(enclosing, 'package.json'))) unsupported('Selected projectRoot excludes the controlling package.json scope');
        }
        return nearest;
      };
      const visit = async (path: string, depth: number): Promise<void> => {
        state.checkDepth(depth);
        if (visited.has(path)) return;
        visited.add(path);
        const bytes = await addSource(path);
        const packageScope = await scope(path);
        if (extname(path) === '.json') return;
        if (!CODE.has(extname(path))) unsupported(`Unsupported local module type: ${portable(root, path)}`);
        if (bytes.length > MAX_PARSE_BYTES) throw new SourceIdentityError('budget', 'Source module exceeds the 2 MiB parsing limit');
        const { inspectSourceModule } = await import('./export-source.js');
        state.check();
        let inspected: ReturnType<typeof inspectSourceModule>;
        try { inspected = inspectSourceModule(decode(bytes), portable(root, path)); }
        catch (error) { throw new SourceIdentityError('unsupported', errorMessage(error), { cause: error }); }
        state.check();
        if (inspected.unsupported.length) unsupported(`Unsupported source loader in ${portable(root, path)}: ${inspected.unsupported.join('; ')}`);
        for (const dependency of inspected.imports) {
          if (dependency.typeOnly || isBuiltin(dependency.specifier)) continue;
          if (dependency.specifier.startsWith('.')) {
            const imported = await resolveLocal(root, path, dependency, state, addSource);
            await visit(imported, depth + 1);
          } else {
            const name = packageName(dependency.specifier);
            if (packageScope?.name === name && packageScope.exports !== undefined) unsupported('Package self-reference aliases are unsupported; use literal relative imports');
            imports.push({ name: dependency.specifier, from: dirname(path), importer: portable(root, path) });
            // Validate the package-name prefix without exporting installation paths.
            if (!name) unsupported('Unsupported package import');
          }
        }
      };
      await visit(entry, 0);
      for (const name of ['package.json', 'package-lock.json']) {
        const path = join(root, name);
        if (await state.exists(path)) await addSource(path);
      }
      for (const include of includes) {
        const path = resolve(root, include); inside(root, path);
        await walk(root, path, state, async file => { await addSource(file); }, () => true);
      }
      const sourceComponent = fileComponent([...source.values()]);
      const dependencies = await dependencyGraph(imports, state);
      const runtime = await captureRuntime(state, builtRuntimeRoot);
      const fileCount = sourceComponent.fileCount + dependencies.fileCount + runtime.fileCount;
      const byteCount = sourceComponent.byteCount + dependencies.byteCount + runtime.byteCount;
      state.checkOutput(fileCount, byteCount);
      await state.verifyUnchanged();
      const selected = { entry: portable(root, entry), includes, sharedPackages: state.sharedPackages(), components: { source: sourceComponent, dependencies, runtime } };
      return {
        version: 1, profile: 'node-source-v1', algorithm: 'sha256',
        fingerprint: hashJson({ version: 1, profile: 'node-source-v1', ...selected }), ...selected,
        fileCount, byteCount,
      };
    });
  } catch (error) {
    if (error instanceof SourceIdentityError) throw error;
    throw new SourceIdentityError('io', `Source identity capture failed: ${errorMessage(error)}`, { cause: error });
  }
}

class CaptureState {
  readonly maxFiles: number;
  readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly started = performance.now();
  private readonly signal: AbortSignal | undefined;
  private readonly files = new Map<string, CachedFile>();
  private readonly packages = { dependencies: new Map<string, string>(), runtime: new Map<string, string>() };
  private bytes = 0;
  private entries = 0;
  private failure: SourceIdentityError | undefined;
  constructor(options: CaptureSourceIdentityOptions) {
    this.maxFiles = limit(options.maxFiles, 10_000, 100_000, 'maxFiles');
    this.maxBytes = limit(options.maxBytes, 64 * 1024 * 1024, 256 * 1024 * 1024, 'maxBytes');
    this.timeoutMs = limit(options.timeoutMs, 10_000, 120_000, 'timeoutMs');
    this.signal = options.signal;
  }
  check(): void {
    if (this.failure) throw this.failure;
    if (this.signal?.aborted) throw (this.failure = new SourceIdentityError('aborted', 'Source identity capture was aborted'));
    if (performance.now() - this.started >= this.timeoutMs) throw (this.failure = new SourceIdentityError('budget', 'Source identity deadline exceeded'));
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let rejectBoundary!: (error: Error) => void;
    const boundary = new Promise<never>((_, reject) => { rejectBoundary = reject; });
    const stop = (kind: 'budget' | 'aborted', message: string) => {
      this.failure ??= new SourceIdentityError(kind, message); rejectBoundary(this.failure);
    };
    const abort = () => stop('aborted', 'Source identity capture was aborted');
    const timer = setTimeout(() => stop('budget', 'Source identity deadline exceeded'), this.timeoutMs);
    this.signal?.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([work(), boundary]); }
    finally { clearTimeout(timer); this.signal?.removeEventListener('abort', abort); }
  }
  checkDepth(depth: number): void { this.check(); if (depth > MAX_DEPTH) throw new SourceIdentityError('budget', `Source identity traversal exceeds depth ${MAX_DEPTH}`); }
  checkOutput(files: number, bytes: number): void {
    this.check();
    if (files > this.maxFiles || bytes > this.maxBytes) throw new SourceIdentityError('budget', 'Source identity manifest exceeds its file/byte limit');
  }
  recordPackage(component: 'dependencies' | 'runtime', path: string, id: string): void { this.packages[component].set(path, id); }
  sharedPackages(): SourceIdentity['sharedPackages'] {
    const shared: SourceIdentity['sharedPackages'] = [];
    for (const [path, dependencyPackageId] of this.packages.dependencies) {
      const runtimePackageId = this.packages.runtime.get(path);
      if (runtimePackageId !== undefined) shared.push({ dependencyPackageId, runtimePackageId });
    }
    return shared.sort((a, b) => compare(a.dependencyPackageId, b.dependencyPackageId));
  }
  entry(): void { this.check(); if (++this.entries > this.maxFiles * 4 + 256) throw new SourceIdentityError('budget', 'Source identity directory-entry limit exceeded'); }
  async exists(path: string): Promise<boolean> {
    this.check();
    try { await lstat(path); this.check(); return true; }
    catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return false; throw error; }
  }
  async read(root: string, path: string): Promise<Buffer> {
    this.check(); inside(root, path); await noSymlinks(root, path, this);
    const previous = this.files.get(path);
    if (previous) return previous.bytes;
    if (this.files.size >= this.maxFiles) throw new SourceIdentityError('budget', 'Source identity file limit exceeded');
    // NONBLOCK avoids waiting indefinitely if a file is replaced by a FIFO.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      this.check();
      const before = await handle.stat();
      if (!before.isFile()) unsupported('Source identity requires ordinary files');
      if (before.size > MAX_FILE_BYTES || before.size > this.maxBytes - this.bytes) throw new SourceIdentityError('budget', 'Source identity byte limit exceeded');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        this.check();
        const result = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      this.check();
      const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
      const after = await handle.stat();
      if (offset !== before.size || extra.bytesRead || !sameFile(before, after)) throw new SourceIdentityError('changed', 'File changed during source identity capture');
      this.bytes += bytes.length;
      this.files.set(path, { bytes, stats: after, root });
      return bytes;
    } finally { await handle.close(); }
  }
  async verifyUnchanged(): Promise<void> {
    for (const [path, saved] of this.files) {
      this.check(); await noSymlinks(saved.root, path, this);
      if (!sameFile(saved.stats, await lstat(path))) throw new SourceIdentityError('changed', 'File changed during source identity capture');
    }
    this.check();
  }
}

async function nearestProjectRoot(start: string, state: CaptureState): Promise<string> {
  await ordinaryDirectory(start, state);
  const original = start;
  let directory = original;
  while (true) {
    if (await state.exists(join(directory, 'package.json'))) return directory;
    if (dirname(directory) === directory) return original;
    directory = dirname(directory);
  }
}

async function ordinaryDirectory(path: string, state: CaptureState): Promise<string> {
  state.check(); const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) unsupported('Source identity requires ordinary directories');
  const canonical = await realpath(path); state.check(); return canonical;
}

async function noSymlinks(root: string, path: string, state: CaptureState): Promise<void> {
  inside(root, path);
  let current = root;
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    state.check(); if (part) current = join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) unsupported('Symbolic links are unsupported in source identity inputs');
  }
}

async function resolveLocal(root: string, importer: string, dependency: SourceDependency, state: CaptureState, metadata: (path: string) => Promise<Buffer>): Promise<string> {
  if (dependency.kind === 'import') {
    let url: URL;
    try { url = new URL(dependency.specifier, pathToFileURL(importer)); }
    catch { unsupported('Invalid relative module URL'); }
    if (url!.search || url!.hash || url!.protocol !== 'file:') unsupported('Module URL queries/fragments are unsupported');
    let path: string;
    try { path = fileURLToPath(url!); } catch { unsupported('Unsupported encoded module path'); }
    inside(root, path!); await noSymlinks(root, path!, state);
    if (!(await lstat(path!)).isFile()) unsupported('ES module imports must resolve to an exact ordinary file');
    return path!;
  }
  const base = resolve(dirname(importer), dependency.specifier); inside(root, base);
  const loadAsFile = async (candidate: string): Promise<string | undefined> => {
    state.check();
    for (const path of [candidate, `${candidate}.js`, `${candidate}.json`, `${candidate}.node`]) {
      inside(root, path);
      if (!await state.exists(path)) continue;
      await noSymlinks(root, path, state);
      if (!(await lstat(path)).isFile()) continue;
      if (extname(path) === '.node') unsupported('Native addons are unsupported by source identity');
      return path;
    }
  };
  const loadIndex = async (candidate: string): Promise<string | undefined> => {
    for (const extension of ['.js', '.json', '.node']) {
      const path = join(candidate, `index${extension}`);
      inside(root, path);
      if (await state.exists(path)) {
        await noSymlinks(root, path, state);
        if ((await lstat(path)).isFile()) {
          if (extension === '.node') unsupported('Native addons are unsupported by source identity');
          return path;
        }
      }
    }
  };
  const loadAsDirectory = async (candidate: string): Promise<string | undefined> => {
    if (!await state.exists(candidate)) return;
    await noSymlinks(root, candidate, state);
    if (!(await lstat(candidate)).isDirectory()) return;
    const packageFile = join(candidate, 'package.json');
    if (await state.exists(packageFile)) {
      const value = object(await metadata(packageFile), 'Local package metadata');
      if (typeof value.main === 'string' && value.main) {
        const target = resolve(candidate, value.main); inside(root, target);
        // Node tries the main target as a file, then its index; it does not
        // recursively read another package.json at a directory main target.
        const result = await loadAsFile(target) ?? await loadIndex(target);
        if (result) return result;
      }
    }
    return loadIndex(candidate);
  };
  const directoryRequest = /(?:\/|(?:^|\/)\.{1,2})$/.test(dependency.specifier);
  const result = (directoryRequest ? undefined : await loadAsFile(base)) ?? await loadAsDirectory(base);
  if (!result) unsupported(`Required relative module does not exist: ${dependency.specifier}`);
  return result!;
}

async function walk(root: string, path: string, state: CaptureState, file: (path: string) => Promise<void>, allow: (relativePath: string, directory: boolean) => boolean, depth = 0): Promise<void> {
  state.checkDepth(depth); await noSymlinks(root, path, state);
  const stats = await lstat(path);
  if (stats.isFile()) { if (allow(portable(root, path), false)) await file(path); return; }
  if (!stats.isDirectory()) unsupported('Only ordinary files and directories can be captured');
  if (!allow(portable(root, path), true)) return;
  const entries: Array<{ name: string; directory: boolean }> = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    state.entry();
    if (entry.isSymbolicLink()) unsupported('Symbolic links are unsupported in source identity inputs');
    entries.push({ name: entry.name, directory: entry.isDirectory() });
  }
  entries.sort((a, b) => compare(a.name, b.name));
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (allow(portable(root, child), entry.directory)) await walk(root, child, state, file, allow, depth + 1);
  }
}

async function findPackage(name: string, from: string, state: CaptureState): Promise<string | undefined> {
  name = packageName(name);
  let directory = from;
  while (true) {
    state.check();
    // NODE_MODULES_PATHS does not append another node_modules segment to an
    // ancestor already named node_modules.
    if (basename(directory) !== 'node_modules') {
      const candidate = join(directory, 'node_modules', name);
      if (await state.exists(candidate)) {
        await noSymlinks(directory, candidate, state);
        if (!(await lstat(candidate)).isDirectory()) unsupported('Installed package root is not an ordinary directory');
        if (!await state.exists(join(candidate, 'package.json'))) unsupported(`Installed package lacks metadata: ${name}`);
        return candidate;
      }
    }
    if (dirname(directory) === directory) return;
    directory = dirname(directory);
  }
}

function declaredDependencies(metadata: Json, from: string): DependencyRequest[] {
  const dependencies = plain(metadata.dependencies ?? {}, 'dependencies');
  const optional = plain(metadata.optionalDependencies ?? {}, 'optionalDependencies');
  const peers = plain(metadata.peerDependencies ?? {}, 'peerDependencies');
  const peerMeta = plain(metadata.peerDependenciesMeta ?? {}, 'peerDependenciesMeta');
  return [...new Set([...Object.keys(dependencies), ...Object.keys(optional), ...Object.keys(peers)])].sort(compare).map(name => {
    packageName(name);
    const isOptional = Object.hasOwn(optional, name)
      || (!Object.hasOwn(dependencies, name) && plain(peerMeta[name] ?? {}, 'peer dependency metadata').optional === true);
    return { name, from, ...(isOptional ? { optional: true as const } : {}) };
  });
}

async function dependencyGraph(requests: DependencyRequest[], state: CaptureState, component: 'dependencies' | 'runtime' = 'dependencies', allowRuntimeNative = false): Promise<SourceIdentityDependencies> {
  const nodes: SourceIdentityPackage[] = [];
  const known = new Map<string, string>();
  const edge = async (request: DependencyRequest, depth: number): Promise<SourceIdentityDependency> => {
    state.checkDepth(depth);
    const directory = await findPackage(request.name, request.from, state);
    if (!directory) {
      if (request.optional) return { name: request.name, optional: true, missing: true };
      unsupported(`Required installed dependency is missing: ${request.name}`);
    }
    const existing = known.get(directory!);
    if (existing) return { name: request.name, packageId: existing, ...(request.optional ? { optional: true as const } : {}) };
    const id = `p${nodes.length}`; known.set(directory!, id);
    state.recordPackage(component, directory!, id);
    const metadataBytes = await state.read(directory!, join(directory!, 'package.json'));
    const metadata = object(metadataBytes, 'Installed package metadata');
    if (typeof metadata.main === 'string') inside(directory!, resolve(directory!, metadata.main));
    if (typeof metadata.name !== 'string' || Buffer.byteLength(metadata.name) > 256 || !PACKAGE_NAME.test(metadata.name)) unsupported('Installed dependency has an invalid package name');
    if (typeof metadata.version !== 'string' || Buffer.byteLength(metadata.version) > 256 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(metadata.version)) unsupported('Installed dependency has an invalid version');
    const node: SourceIdentityPackage = { id, name: metadata.name as string, version: metadata.version as string, ...fileComponent([]), dependencies: [] };
    nodes.push(node);
    const files: SourceIdentityFile[] = [];
    await walk(directory!, directory!, state, async path => {
      if (extname(path) === '.node' && !(component === 'runtime' && allowRuntimeNative)) unsupported('Native addons are unsupported by source identity');
      files.push(record(portable(directory!, path), await state.read(directory!, path)));
    // Only the package-root installation directory belongs to the separate
    // dependency graph. Nested package-owned fixtures remain actual file inputs.
    }, path => path.split('/')[0] !== 'node_modules');
    Object.assign(node, fileComponent(files));
    for (const child of declaredDependencies(metadata, directory!)) node.dependencies.push(await edge(child, depth + 1));
    return { name: request.name, packageId: id, ...(request.optional ? { optional: true as const } : {}) };
  };
  const roots: SourceIdentityDependency[] = [];
  const unique = new Set<string>();
  for (const request of [...requests].sort((a, b) => compare(a.name, b.name) || compare(a.importer ?? '', b.importer ?? ''))) {
    const resolved = await findPackage(request.name, request.from, state);
    const key = `${request.importer ?? ''}\0${request.name}\0${resolved ?? ''}`;
    if (unique.has(key)) continue;
    unique.add(key); roots.push({ ...await edge(request, 0), ...(request.importer ? { from: request.importer } : {}) });
  }
  return { fingerprint: hashJson({ roots, packages: nodes }), roots, packages: nodes,
    fileCount: nodes.reduce((sum, node) => sum + node.fileCount, 0), byteCount: nodes.reduce((sum, node) => sum + node.byteCount, 0) };
}

async function captureRuntime(state: CaptureState, builtRuntimeRoot?: string): Promise<SourceIdentityRuntime> {
  const module = fileURLToPath(import.meta.url);
  const mode = builtRuntimeRoot !== undefined ? 'build' : extname(module) === '.ts' ? 'source' : 'build';
  const root = builtRuntimeRoot !== undefined
    ? await ordinaryDirectory(resolvePath(builtRuntimeRoot, 'runtimeRoot'), state)
    : dirname(dirname(module));
  const directory = builtRuntimeRoot !== undefined ? join(root, 'dist') : dirname(module);
  if (basename(directory) !== (mode === 'source' ? 'src' : 'dist')) unsupported('Unrecognized Interleave runtime layout');
  if (builtRuntimeRoot !== undefined) {
    await ordinaryDirectory(directory, state);
    await state.read(root, join(directory, 'source-identity.js'));
  }
  const metadataBytes = await state.read(root, join(root, 'package.json'));
  const metadata = object(metadataBytes, 'Interleave runtime metadata');
  if (metadata.name !== '@pavangupta352/interleave') unsupported('Unrecognized Interleave runtime package');
  const files = [record('package.json', metadataBytes)];
  await walk(root, directory, state, async path => { files.push(record(portable(root, path), await state.read(root, path))); }, (path, isDirectory) => {
    const parts = path.split('/');
    if (parts.includes('node_modules')) unsupported('Nested node_modules within the Interleave runtime implementation directory are unsupported; install runtime dependencies at the package root');
    if (parts.some(part => ['report', 'cli', 'examples', 'vendor'].includes(part))) return false;
    return isDirectory || (path.endsWith(mode === 'source' ? '.ts' : '.js') && !path.endsWith('.d.ts'));
  });
  const component = fileComponent(files);
  const runtimeDependencies = declaredDependencies(metadata, root);
  if (mode === 'source') {
    // Source workers execute through tsx, and the unbundled import inspector
    // loads TypeScript. Their installed bytes and transitive toolchain matter
    // even though they are development dependencies in the package manifest.
    for (const name of ['tsx', 'typescript']) runtimeDependencies.push({ name, from: root });
  }
  const dependencies = await dependencyGraph(runtimeDependencies, state, 'runtime', mode === 'source');
  return { ...component, mode, dependencies,
    fingerprint: hashJson({ mode, files: component.files, dependencies: dependencies.fingerprint }),
    fileCount: component.fileCount + dependencies.fileCount, byteCount: component.byteCount + dependencies.byteCount };
}

function fileComponent(files: SourceIdentityFile[]): SourceIdentityFiles {
  files.sort((a, b) => compare(a.path, b.path));
  return { files, fingerprint: hashJson(files), fileCount: files.length, byteCount: files.reduce((sum, file) => sum + file.bytes, 0) };
}
function record(path: string, bytes: Buffer): SourceIdentityFile { return { path: portablePath(path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
function hashJson(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function portable(root: string, path: string): string {
  const result = relative(root, path).split(sep).join('/');
  // An empty path is used only while traversing a package's root directory.
  return result ? portablePath(result) : result;
}
function portablePath(path: string, allowDot = false): string {
  if (allowDot && path === '.') return path;
  if (!path || Buffer.byteLength(path) > 4096 || path.startsWith('/') || path.endsWith('/')
      || path.includes('\\') || path.includes(':') || /[\u0000-\u001f\u007f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')) unsupported('Source identity requires safe portable relative paths');
  return path;
}
function inside(root: string, path: string): void { const rel = relative(root, path); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) unsupported('Local source path escapes its selected root'); }
function resolvePath(value: string, label: string): string { if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) unsupported(`Invalid ${label}`); return resolve(value); }
function normalizeIncludes(value: string[] | undefined, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) unsupported('Includes must be a bounded list of relative paths');
  const selected = value.map(item => {
    if (typeof item !== 'string' || !item || item.length > 4096 || isAbsolute(item) || item.includes('\\') || item.includes('\0') || item.split('/').includes('..')) unsupported('Includes must stay inside the project root');
    return portablePath(item.split('/').filter(part => part && part !== '.').join('/') || '.', true);
  });
  return [...new Set(selected)].sort(compare);
}
function packageName(specifier: string): string {
  if (!specifier || Buffer.byteLength(specifier) > 4096 || specifier.startsWith('.') || specifier.startsWith('/')
      || specifier.includes(':') || specifier.includes('\\') || specifier.startsWith('#')
      || /[\u0000-\u001f\u007f]/.test(specifier)
      || specifier.split('/').some(part => !part || part === '..' || part === '.')) unsupported(`Unsupported external or aliased module import: ${specifier}`);
  const parts = specifier.split('/'); const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  if (!PACKAGE_NAME.test(name)) unsupported('Invalid installed package import'); return name;
}
function limit(value: number | undefined, fallback: number, maximum: number, label: string): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1 || result > maximum) unsupported(`${label} must be a positive integer at most ${maximum}`); return result; }
function decode(bytes: Buffer): string { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return unsupported('Source metadata/code is not valid UTF-8'); } }
function object(bytes: Buffer, label: string): Json { try { return plain(JSON.parse(decode(bytes)), label); } catch (error) { if (error instanceof SourceIdentityError) throw error; return unsupported(`${label} is not valid JSON`); } }
function plain(value: unknown, label: string): Json { if (!value || typeof value !== 'object' || Array.isArray(value)) unsupported(`Invalid ${label}`); return value as Json; }
function sameFile(a: Stats, b: Stats): boolean { return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function hasCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function unsupported(message: string): never { throw new SourceIdentityError('unsupported', message); }
