import type { SourceIdentity, SourceIdentityFile, SourceIdentityPackage } from './source-identity.js';

const MAX_ITEMS = 100_000;
const MAX_SOURCE_FILES = 100_000;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_STRING_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const PACKAGE_NAME = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

interface FilesValidation {
  files: SourceIdentityFile[];
  paths: Set<string>;
  fileCount: number;
  byteCount: number;
  fingerprint: string;
}
interface GraphValidation {
  packages: Map<string, SourceIdentityPackage>;
  fileCount: number;
  byteCount: number;
}

/** @internal Validate inert source provenance without importing Node runtime modules. */
export function validateSourceIdentity(value: unknown, path = '$.environment.source'): asserts value is SourceIdentity {
  const source = shape(value, path, [
    'version', 'profile', 'algorithm', 'fingerprint', 'entry', 'includes', 'sharedPackages',
    'components', 'fileCount', 'byteCount',
  ]);
  if (source.version !== 1) throw new TypeError(`${path}.version: expected source identity version 1`);
  exact(source.profile, 'node-source-v1', `${path}.profile`);
  exact(source.algorithm, 'sha256', `${path}.algorithm`);
  fingerprint(source.fingerprint, `${path}.fingerprint`);

  const components = shape(source.components, `${path}.components`, ['source', 'dependencies', 'runtime']);
  const sourceFiles = validateFiles(components.source, `${path}.components.source`);
  const entry = portablePath(source.entry, `${path}.entry`);
  if (!sourceFiles.paths.has(entry)) throw new TypeError(`${path}.entry: entry is absent from the source manifest`);

  const includes = array(source.includes, `${path}.includes`);
  let previousInclude: string | undefined;
  for (let index = 0; index < includes.length; index += 1) {
    const include = portablePath(includes[index], `${path}.includes[${index}]`, true);
    if (previousInclude !== undefined && include <= previousInclude) {
      throw new TypeError(`${path}.includes: paths must be unique and sorted`);
    }
    previousInclude = include;
  }

  const dependencies = validateGraph(
    components.dependencies,
    `${path}.components.dependencies`,
    'source',
    sourceFiles.paths,
  );
  const runtime = shape(components.runtime, `${path}.components.runtime`, [
    'mode', 'fingerprint', 'files', 'fileCount', 'byteCount', 'dependencies',
  ]);
  if (runtime.mode !== 'source' && runtime.mode !== 'build') {
    throw new TypeError(`${path}.components.runtime.mode: expected source or build`);
  }
  fingerprint(runtime.fingerprint, `${path}.components.runtime.fingerprint`);
  const runtimeFiles = validateFileList(runtime.files, `${path}.components.runtime.files`);
  const runtimeDependencies = validateGraph(
    runtime.dependencies,
    `${path}.components.runtime.dependencies`,
    'runtime',
    sourceFiles.paths,
  );
  const runtimeFileCount = sum(runtimeFiles.fileCount, runtimeDependencies.fileCount, `${path}.components.runtime.fileCount`);
  const runtimeByteCount = sum(runtimeFiles.byteCount, runtimeDependencies.byteCount, `${path}.components.runtime.byteCount`);
  equalCount(runtime.fileCount, runtimeFileCount, `${path}.components.runtime.fileCount`);
  equalCount(runtime.byteCount, runtimeByteCount, `${path}.components.runtime.byteCount`);

  validateSharedPackages(
    source.sharedPackages,
    dependencies.packages,
    runtimeDependencies.packages,
    `${path}.sharedPackages`,
  );

  const totalFiles = sum(sourceFiles.fileCount, dependencies.fileCount, `${path}.fileCount`);
  const fileCount = sum(totalFiles, runtimeFileCount, `${path}.fileCount`);
  const totalBytes = sum(sourceFiles.byteCount, dependencies.byteCount, `${path}.byteCount`);
  const byteCount = sum(totalBytes, runtimeByteCount, `${path}.byteCount`);
  equalCount(source.fileCount, fileCount, `${path}.fileCount`);
  equalCount(source.byteCount, byteCount, `${path}.byteCount`);
  if (fileCount > MAX_SOURCE_FILES || byteCount > MAX_SOURCE_BYTES) {
    throw new TypeError(`${path}: source identity exceeds its file or byte limit`);
  }
}

function validateFiles(value: unknown, path: string): FilesValidation {
  const files = shape(value, path, ['fingerprint', 'files', 'fileCount', 'byteCount']);
  const fingerprintValue = fingerprint(files.fingerprint, `${path}.fingerprint`);
  const manifest = validateFileList(files.files, `${path}.files`);
  equalCount(files.fileCount, manifest.fileCount, `${path}.fileCount`);
  equalCount(files.byteCount, manifest.byteCount, `${path}.byteCount`);
  return { ...manifest, fingerprint: fingerprintValue };
}

function validateFileList(value: unknown, path: string): Omit<FilesValidation, 'fingerprint'> {
  const values = array(value, path);
  const files: SourceIdentityFile[] = [];
  const paths = new Set<string>();
  let byteCount = 0;
  let previousPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const file = shape(values[index], itemPath, ['path', 'bytes', 'sha256']);
    const portable = portablePath(file.path, `${itemPath}.path`);
    if (previousPath !== undefined && portable <= previousPath) {
      throw new TypeError(`${path}: manifest paths must be unique and sorted`);
    }
    previousPath = portable;
    paths.add(portable);
    const bytes = safeInteger(file.bytes, `${itemPath}.bytes`);
    if (bytes > MAX_FILE_BYTES) throw new TypeError(`${itemPath}.bytes: file exceeds the source identity byte limit`);
    byteCount = sum(byteCount, bytes, `${path}: byte sum`);
    files.push({ path: portable, bytes, sha256: fingerprint(file.sha256, `${itemPath}.sha256`) });
  }
  return { files, paths, fileCount: files.length, byteCount };
}

function validateGraph(value: unknown, path: string, kind: 'source' | 'runtime', sourcePaths: Set<string>): GraphValidation {
  const graph = shape(value, path, ['fingerprint', 'roots', 'packages', 'fileCount', 'byteCount']);
  fingerprint(graph.fingerprint, `${path}.fingerprint`);
  const packageValues = array(graph.packages, `${path}.packages`);
  const packages = new Map<string, SourceIdentityPackage>();
  const pendingDependencies: unknown[][] = [];
  let fileCount = 0;
  let byteCount = 0;
  for (let index = 0; index < packageValues.length; index += 1) {
    const packagePath = `${path}.packages[${index}]`;
    const item = shape(packageValues[index], packagePath, [
      'id', 'name', 'version', 'fingerprint', 'files', 'fileCount', 'byteCount', 'dependencies',
    ]);
    const id = packageId(item.id, `${packagePath}.id`);
    if (id !== `p${index}` || packages.has(id)) {
      throw new TypeError(`${packagePath}.id: package ids must be unique contiguous pN identifiers`);
    }
    const name = packageName(item.name, `${packagePath}.name`);
    const version = text(item.version, `${packagePath}.version`, 1, 256);
    if (!PACKAGE_VERSION.test(version)) throw new TypeError(`${packagePath}.version: invalid package version`);
    const files = validateFiles({
      fingerprint: item.fingerprint,
      files: item.files,
      fileCount: item.fileCount,
      byteCount: item.byteCount,
    }, packagePath);
    const dependencyValues = array(item.dependencies, `${packagePath}.dependencies`);
    const result: SourceIdentityPackage = {
      id, name, version, fingerprint: files.fingerprint, files: files.files,
      fileCount: files.fileCount, byteCount: files.byteCount, dependencies: [],
    };
    packages.set(id, result);
    pendingDependencies.push(dependencyValues);
    fileCount = sum(fileCount, files.fileCount, `${path}.fileCount`);
    byteCount = sum(byteCount, files.byteCount, `${path}.byteCount`);
  }
  for (const [id, pkg] of packages) {
    const dependencyValues = pendingDependencies[Number(id.slice(1))]!;
    let previousEdge: string | undefined;
    for (let index = 0; index < dependencyValues.length; index += 1) {
      const dependency = validateDependency(
        dependencyValues[index], `${path}.packages[${id.slice(1)}].dependencies[${index}]`, packages,
      );
      previousEdge = orderedEdge(dependency, previousEdge, `${path}.packages[${id.slice(1)}].dependencies`);
      pkg.dependencies.push(dependency);
    }
  }
  const roots = array(graph.roots, `${path}.roots`);
  let previousRoot: string | undefined;
  for (let index = 0; index < roots.length; index += 1) {
    const dependency = validateDependency(
      roots[index], `${path}.roots[${index}]`, packages,
      kind === 'source' ? sourcePaths : undefined,
    );
    previousRoot = orderedEdge(dependency, previousRoot, `${path}.roots`);
  }
  equalCount(graph.fileCount, fileCount, `${path}.fileCount`);
  equalCount(graph.byteCount, byteCount, `${path}.byteCount`);
  return { packages, fileCount, byteCount };
}

function validateDependency(
  value: unknown,
  path: string,
  packages: Map<string, SourceIdentityPackage>,
  sourcePaths?: Set<string>,
): SourceIdentityPackage['dependencies'][number] {
  const dependency = shape(value, path, ['name', 'from', 'packageId', 'optional', 'missing'], ['name']);
  const name = dependencySpecifier(dependency.name, `${path}.name`);
  const optional = hasOwn(dependency, 'optional');
  if (optional && dependency.optional !== true) throw new TypeError(`${path}.optional: only literal true is allowed`);
  const missing = hasOwn(dependency, 'missing');
  if (missing && dependency.missing !== true) throw new TypeError(`${path}.missing: only literal true is allowed`);
  const hasPackage = hasOwn(dependency, 'packageId');
  if (missing) {
    if (!optional || hasPackage) throw new TypeError(`${path}: missing dependencies must be optional and omit packageId`);
  } else {
    if (!hasPackage) throw new TypeError(`${path}.packageId: resolved dependencies require a package reference`);
    const id = packageId(dependency.packageId, `${path}.packageId`);
    if (!packages.has(id)) throw new TypeError(`${path}.packageId: package reference does not exist`);
  }
  if (sourcePaths !== undefined) {
    if (!hasOwn(dependency, 'from')) throw new TypeError(`${path}.from: source roots require an importer path`);
    const from = portablePath(dependency.from, `${path}.from`);
    if (!sourcePaths.has(from)) throw new TypeError(`${path}.from: importer is absent from the source manifest`);
  } else if (hasOwn(dependency, 'from')) {
    throw new TypeError(`${path}.from: only application source roots may name an importer`);
  }
  return dependency as unknown as SourceIdentityPackage['dependencies'][number];
}

function validateSharedPackages(
  value: unknown,
  dependencies: Map<string, SourceIdentityPackage>,
  runtime: Map<string, SourceIdentityPackage>,
  path: string,
): void {
  const values = array(value, path);
  const usedDependencies = new Set<string>();
  const usedRuntime = new Set<string>();
  let previousDependency: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const item = shape(values[index], itemPath, ['dependencyPackageId', 'runtimePackageId']);
    const dependencyId = packageId(item.dependencyPackageId, `${itemPath}.dependencyPackageId`);
    const runtimeId = packageId(item.runtimePackageId, `${itemPath}.runtimePackageId`);
    if (previousDependency !== undefined && dependencyId <= previousDependency) {
      throw new TypeError(`${path}: shared package mappings must be unique and sorted`);
    }
    previousDependency = dependencyId;
    if (usedDependencies.has(dependencyId) || usedRuntime.has(runtimeId)) {
      throw new TypeError(`${itemPath}: duplicate shared package reference`);
    }
    usedDependencies.add(dependencyId); usedRuntime.add(runtimeId);
    const dependency = dependencies.get(dependencyId);
    const runtimePackage = runtime.get(runtimeId);
    if (!dependency || !runtimePackage) throw new TypeError(`${itemPath}: shared package reference does not exist`);
    if (
      dependency.name !== runtimePackage.name
      || dependency.version !== runtimePackage.version
      || dependency.fingerprint !== runtimePackage.fingerprint
      || dependency.fileCount !== runtimePackage.fileCount
      || dependency.byteCount !== runtimePackage.byteCount
      || JSON.stringify(dependency.files) !== JSON.stringify(runtimePackage.files)
    ) {
      throw new TypeError(`${itemPath}: shared package mappings must describe the same package files and version`);
    }
  }
}

function orderedEdge(
  dependency: SourceIdentityPackage['dependencies'][number],
  previous: string | undefined,
  path: string,
): string {
  const key = `${dependency.name}\0${dependency.from ?? ''}\0${dependency.packageId ?? ''}\0${dependency.missing === true ? 'missing' : ''}`;
  if (previous !== undefined && key <= previous) {
    throw new TypeError(`${path}: dependency edges must be unique and sorted`);
  }
  return key;
}

function shape(value: unknown, path: string, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path}: expected an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path}: expected a plain object prototype`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new TypeError(`${path}.${key}: unknown field`);
  for (const key of required) if (!hasOwn(record, key)) throw new TypeError(`${path}.${key}: required field is missing`);
  return record;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path}: expected an array`);
  if (value.length > MAX_ITEMS) throw new TypeError(`${path}: array exceeds the item limit`);
  return value;
}

function portablePath(value: unknown, path: string, allowDot = false): string {
  const result = text(value, path, 1, MAX_PATH_BYTES);
  if (allowDot && result === '.') return result;
  if (
    result === '.' || result.startsWith('/') || result.endsWith('/') || result.includes('\\')
    || result.includes(':') || /[\u0000-\u001f\u007f]/.test(result)
    || result.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new TypeError(`${path}: expected a safe portable relative path`);
  }
  return result;
}

function dependencySpecifier(value: unknown, path: string): string {
  const result = text(value, path, 1, MAX_PATH_BYTES);
  if (
    result.startsWith('.') || result.startsWith('/') || result.startsWith('#')
    || result.includes(':') || result.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(result)
    || result.split('/').some(part => !part || part === '.' || part === '..')
  ) throw new TypeError(`${path}: expected a portable installed-package specifier`);
  const parts = result.split('/');
  const name = result.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  if (!PACKAGE_NAME.test(name)) throw new TypeError(`${path}: invalid package name`);
  return result;
}

function packageName(value: unknown, path: string): string {
  const result = text(value, path, 1, 256);
  if (!PACKAGE_NAME.test(result)) throw new TypeError(`${path}: invalid package name`);
  return result;
}

function packageId(value: unknown, path: string): string {
  const result = text(value, path, 2, 16);
  if (!/^p(?:0|[1-9]\d*)$/.test(result)) throw new TypeError(`${path}: invalid package id`);
  return result;
}

function fingerprint(value: unknown, path: string): string {
  const result = text(value, path, 64, 64);
  if (!HASH.test(result)) throw new TypeError(`${path}: expected a lowercase SHA-256 fingerprint`);
  return result;
}

function safeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${path}: expected a nonnegative safe integer`);
  return value as number;
}

function equalCount(value: unknown, expected: number, path: string): void {
  const actual = safeInteger(value, path);
  if (actual !== expected) throw new TypeError(`${path}: expected exact total ${expected}`);
}

function sum(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${path}: aggregate count exceeds the safe integer limit`);
  return result;
}

function text(value: unknown, path: string, minimum: number, maximumBytes: number): string {
  if (typeof value !== 'string') throw new TypeError(`${path}: expected a string`);
  const length = new TextEncoder().encode(value).length;
  if (length < minimum || length > maximumBytes) throw new TypeError(`${path}: string exceeds its byte boundary`);
  return value;
}

function exact(value: unknown, expected: string, path: string): void {
  if (value !== expected) throw new TypeError(`${path}: expected ${expected}`);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
