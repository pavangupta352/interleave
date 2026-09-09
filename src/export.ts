import { parseSharedInstallation, prepareSharedArchives, verifySharedArchives, SHARED_RUNTIME, type SharedInstallation } from './export-shared.js';
import { sharedInstallerSource } from './export-install.js';
import { readRuntimeArchive, readOrdinaryFile, assertNoSymlinkComponents, assertInside, safeBundlePath, requiredString, decodeUtf8, hasCode } from './export-archive.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRunArtifact } from './artifact.js';
import { captureExportSourceIdentity, type SourceIdentity, type SourceIdentityFile } from './source-identity.js';
import type { RunResult } from './types.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

export interface ExportRegressionOptions {
  scenarioFile: string;
  projectRoot: string;
  destination: string;
  include?: string[];
  /** Package root for the Interleave runtime. Defaults to the package containing this module. */
  runtimeRoot?: string;
  /** Exact original archive matching the application's runtime lock integrity. */
  runtimeArchive?: string;
  /** Exact archives for local/private locked dependencies. */
  dependencyArchives?: string[];
  /** Preserve original JSON bytes after validating equality with the supplied run. */
  artifactFile?: string;
}

export type RegressionFileRole =
  | 'scenario'
  | 'application-source'
  | 'package-manifest'
  | 'dependency-lock'
  | 'runtime-manifest'
  | 'runtime-lock'
  | 'run-artifact'
  | 'interleave-runtime'
  | 'dependency-archive'
  | 'installer';

export interface RegressionFile {
  path: string;
  role: RegressionFileRole;
  bytes: number;
  sha256: string;
}

export interface RegressionManifest {
  schemaVersion: 1;
  kind: 'interleave-regression';
  createdAt: string;
  fingerprint: string;
  scenario: { name: string; entry: string; sourceFingerprint: string };
  recordedRun: { path: 'run.json'; outcome: 'violation'; failureFingerprint: string };
  project: { package: 'app/package.json'; lock: 'app/package-lock.json' };
  runtime: { package: string; name: string; version: string; fingerprint: string };
  files: RegressionFile[];
  installation?: SharedInstallation;
  replay: {
    install: [string, ...string[]][];
    command: [string, ...string[]];
  };
}

export interface ExportRegressionResult {
  destination: string;
  manifestPath: string;
  fingerprint: string;
  scenario: RegressionManifest['scenario'];
  files: RegressionFile[];
  replay: RegressionManifest['replay'];
}

interface SelectedFile {
  source: string;
  output: string;
  role: RegressionFileRole;
  bytes: Buffer;
}

interface RuntimePackage {
  path: string;
  relativePath: string;
  name: string;
  version: string;
  bytes: Buffer;
}

/**
 * Export a completed violation and explicitly selected trusted local source as
 * a self-contained regression folder. This function copies source; it never
 * imports or executes the selected scenario.
 */
export async function exportRegression(
  run: RunResult,
  options: ExportRegressionOptions,
): Promise<ExportRegressionResult> {
  const validatedRun = parseRunArtifact(run);
  const artifactPath = options.artifactFile === undefined ? undefined : resolveRequired(options.artifactFile, 'artifactFile');
  const originalArtifact = artifactPath === undefined ? undefined : await readOrdinaryFile(artifactPath);
  if (originalArtifact !== undefined && stableJson(parseRunArtifact(decodeUtf8(originalArtifact, 'Original artifact'))) !== stableJson(validatedRun)) throw new Error('Original artifact does not match the supplied run');
  if (validatedRun.outcome !== 'violation' || !validatedRun.failure) {
    throw new TypeError('Regression export requires a completed violation with a failure fingerprint');
  }
  if (!validatedRun.cleanup.complete) {
    throw new TypeError('Regression export requires a completed run with successful cleanup');
  }
  if (validatedRun.trace.some((step) => step.completedAt === undefined || step.completion === undefined)) {
    throw new TypeError('Regression export requires every recorded command to have completed');
  }
  if (options.include !== undefined && (!Array.isArray(options.include)
      || options.include.length > MAX_FILES
      || options.include.some((path) => typeof path !== 'string'))) {
    throw new TypeError(`include must be an array of at most ${MAX_FILES} relative paths`);
  }

  const requestedProjectRoot = resolveRequired(options.projectRoot, 'projectRoot');
  const projectRoot = await ordinaryDirectory(requestedProjectRoot, 'projectRoot');
  const requestedScenarioPath = resolveRequired(options.scenarioFile, 'scenarioFile');
  assertInside(requestedProjectRoot, requestedScenarioPath, 'scenarioFile');
  await assertNoSymlinkComponents(requestedProjectRoot, requestedScenarioPath);
  const scenarioPath = await realpath(requestedScenarioPath);
  assertInside(projectRoot, scenarioPath, 'scenarioFile');
  const requestedDestination = resolveRequired(options.destination, 'destination');
  const destinationParent = await ordinaryDirectory(dirname(requestedDestination), 'destination parent');
  const destination = join(destinationParent, basename(requestedDestination));
  if (destination === destinationParent) {
    throw new TypeError('destination must name a new child directory');
  }
  await assertAbsent(destination);

  const packagePath = join(projectRoot, 'package.json');
  const lockPath = join(projectRoot, 'package-lock.json');
  const selected = new Map<string, SelectedFile>();
  await addScenarioGraph(projectRoot, scenarioPath, selected, new Set<string>(), true);
  await addSelectedFile(projectRoot, packagePath, 'app/package.json', 'package-manifest', selected);
  await addSelectedFile(projectRoot, lockPath, 'app/package-lock.json', 'dependency-lock', selected);
  const includes = options.include ?? validatedRun.environment.source?.includes ?? [];
  for (const include of includes) {
    const includePath = selectedPath(projectRoot, include, 'include');
    await addInclude(projectRoot, includePath, selected);
  }
  const recordedSource = requireRecordedSource(validatedRun);
  const shared = recordedSource.sharedPackages.length > 0;
  if (!shared && (options.runtimeArchive !== undefined || options.dependencyArchives !== undefined)) throw new Error('Archive selection is only supported for a recorded shared app installation');
  validatePackageLock(
    selected.get('app/package.json')!.bytes,
    selected.get('app/package-lock.json')!.bytes, undefined, shared,
  );
  const runtimeRoot = await ordinaryDirectory(options.runtimeRoot ?? fileURLToPath(new URL('../', import.meta.url)), 'runtimeRoot');
  assertUnbundledRuntime(jsonObject(await readOrdinaryFile(join(runtimeRoot, 'package.json'), MAX_FILE_BYTES, runtimeRoot), 'Interleave runtime metadata'));
  const sourceOptions = { projectRoot, include: includes };
  const currentSource = await captureExportSourceIdentity(scenarioPath, sourceOptions, runtimeRoot);
  assertSameSourceIdentity(recordedSource, currentSource);
  assertRecordedApplication(recordedSource, [...selected.values()].map(file => fileRecord(file.output, file.role, file.bytes)));
  const sharedPlan = shared ? await prepareSharedArchives({ ...options, projectRoot, runtimeRoot }, recordedSource, selected.get('app/package-lock.json')!.bytes) : undefined;

  // mkdir claims the final pathname exclusively. POSIX rename can replace an
  // empty directory created by another writer, so it is not a no-clobber publish.
  await mkdir(destination, { mode: 0o700 }).catch((error: unknown) => {
    if (hasCode(error, 'EEXIST')) throw new Error(`Destination already exists; refusing to overwrite: ${destination}`);
    throw error;
  });
  const staging = destination;
  const ownership = await lstat(destination);
  const assertOwnership = async () => {
    const current = await lstat(destination);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownership.dev || current.ino !== ownership.ino) {
      throw new Error('Export destination changed ownership while being written');
    }
  };
  try {
    const fileRecords: RegressionFile[] = [];
    for (const file of [...selected.values()].sort((left, right) => left.output.localeCompare(right.output))) {
      await assertOwnership();
      await writeCopiedFile(staging, file, fileRecords);
    }
    await validateLockedTree(join(staging, 'app'));

    if (artifactPath && originalArtifact && !(await readOrdinaryFile(artifactPath)).equals(originalArtifact)) throw new Error('Original artifact changed while being exported');
    const artifactBytes = originalArtifact ?? Buffer.from(`${JSON.stringify(validatedRun, null, 2)}\n`, 'utf8');
    await writeGeneratedFile(staging, 'run.json', 'run-artifact', artifactBytes, fileRecords);

    const runtime = sharedPlan
      ? { path: join(staging, sharedPlan.runtimeArchive.path), relativePath: sharedPlan.runtimeArchive.path, bytes: sharedPlan.runtimeArchive.bytes, name: '@pavangupta352/interleave', version: jsonObject(readRuntimeArchive(sharedPlan.runtimeArchive.bytes).get('package.json')!, 'Runtime metadata').version as string }
      : await packRuntime(runtimeRoot, staging);
    verifyPackedRuntime(runtime.bytes, recordedSource, runtime);
    if (sharedPlan) {
      for (const archive of sharedPlan.archives) {
        await assertOwnership();
        await writeGeneratedFile(staging, archive.path, archive.path === runtime.relativePath ? 'interleave-runtime' : 'dependency-archive', archive.bytes, fileRecords);
      }
      await writeGeneratedFile(staging, 'install.mjs', 'installer', Buffer.from(sharedInstallerSource(installerConfig(recordedSource, fileRecords, sharedPlan.installation))), fileRecords);
    } else {
      fileRecords.push(fileRecord(runtime.relativePath, 'interleave-runtime', runtime.bytes));
      await assertOwnership();
      await createRuntimeLock(staging, runtime, fileRecords);
    }
    assertSameSourceIdentity(recordedSource, await captureExportSourceIdentity(scenarioPath, sourceOptions, runtimeRoot));
    if (artifactPath && originalArtifact && !(await readOrdinaryFile(artifactPath)).equals(originalArtifact)) throw new Error('Original artifact changed while being exported');

    fileRecords.sort((left, right) => left.path.localeCompare(right.path));
    const scenarioEntry = bundlePath(projectRoot, scenarioPath);
    const sourceFingerprint = recordedSource.components.source.fingerprint;
    const replay: RegressionManifest['replay'] = {
      install: sharedPlan ? [['node', 'install.mjs']] : [
        ['npm', 'ci', '--prefix', 'app'],
        ['npm', 'ci'],
      ],
      command: ['node', `${sharedPlan ? 'app/' : ''}node_modules/@pavangupta352/interleave/dist/cli.js`, 'replay', scenarioEntry, 'run.json', '--project-root', 'app'],
    };
    const unsigned = {
      schemaVersion: 1 as const,
      kind: 'interleave-regression' as const,
      createdAt: new Date().toISOString(),
      scenario: { name: validatedRun.scenario, entry: scenarioEntry, sourceFingerprint },
      recordedRun: {
        path: 'run.json' as const,
        outcome: 'violation' as const,
        failureFingerprint: validatedRun.failure.fingerprint,
      },
      project: { package: 'app/package.json' as const, lock: 'app/package-lock.json' as const },
      runtime: { package: runtime.relativePath, name: runtime.name, version: runtime.version, fingerprint: recordedSource.components.runtime.fingerprint },
      files: fileRecords,
      ...(sharedPlan ? { installation: sharedPlan.installation } : {}),
      replay,
    };
    const manifest: RegressionManifest = { ...unsigned, fingerprint: manifestFingerprint(unsigned) };
    await assertOwnership();
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const verified = await verifyRegressionExport(destination);
    await assertOwnership();
    return {
      destination,
      manifestPath: join(destination, 'manifest.json'),
      fingerprint: verified.fingerprint,
      scenario: verified.scenario,
      files: verified.files,
      replay: verified.replay,
    };
  } catch (error) {
    // A pathname can be replaced after any ownership check. Never recursively
    // delete an uncertain directory; leave partial output for explicit recovery.
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nIncomplete export preserved at ${destination}. Inspect this path before removing it; it may have changed ownership.`, { cause: error });
  }
}

/** Verify every declared byte without loading or executing scenario code. */
export async function verifyRegressionExport(directory: string): Promise<RegressionManifest> {
  const root = await ordinaryDirectory(directory, 'regression directory');
  const manifestBytes = await readOrdinaryFile(join(root, 'manifest.json'), MAX_MANIFEST_BYTES, root);
  const manifest = parseManifest(manifestBytes);
  const expectedFingerprint = manifestFingerprint({
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    scenario: manifest.scenario,
    recordedRun: manifest.recordedRun,
    project: manifest.project,
    runtime: manifest.runtime,
    files: manifest.files,
    ...(manifest.installation ? { installation: manifest.installation } : {}),
    replay: manifest.replay,
  });
  if (manifest.fingerprint !== expectedFingerprint) {
    throw new Error('Regression manifest fingerprint does not match its contents');
  }
  const declared = new Set(['manifest.json']);
  let totalBytes = manifestBytes.length;
  for (const file of manifest.files) {
    if (declared.has(file.path)) throw new TypeError(`Regression manifest contains duplicate path: ${file.path}`);
    declared.add(file.path);
    const bytes = await readOrdinaryFile(join(root, ...file.path.split('/')), MAX_FILE_BYTES, root);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Regression export exceeds the 128 MiB verification limit');
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) {
      throw new Error(`Regression file failed integrity verification: ${file.path}`);
    }
  }
  const actual = new Set(await listBundleFiles(root));
  if (actual.size !== declared.size || [...actual].some((path) => !declared.has(path))) {
    throw new Error('Regression folder contains undeclared files or missing declared files');
  }

  const runFile = manifest.files.find((file) => file.path === manifest.recordedRun.path);
  const scenarioFile = manifest.files.find((file) => file.path === manifest.scenario.entry);
  const packageFile = manifest.files.find((file) => file.path === manifest.project.package);
  const lockFile = manifest.files.find((file) => file.path === manifest.project.lock);
  const runtimeFile = manifest.files.find((file) => file.path === manifest.runtime.package);
  const runtimeManifestFile = manifest.files.find((file) => file.path === 'package.json');
  const runtimeLockFile = manifest.files.find((file) => file.path === 'package-lock.json');
  if (runFile?.role !== 'run-artifact' || scenarioFile?.role !== 'scenario'
      || packageFile?.role !== 'package-manifest' || lockFile?.role !== 'dependency-lock'
      || runtimeFile?.role !== 'interleave-runtime'
      || (!manifest.installation && (runtimeManifestFile?.role !== 'runtime-manifest' || runtimeLockFile?.role !== 'runtime-lock'))
      || (manifest.installation && (runtimeManifestFile || runtimeLockFile || manifest.files.find(file => file.path === 'install.mjs')?.role !== 'installer'))) {
    throw new TypeError('Regression manifest does not bind its required files to their expected roles');
  }
  const parsedRun = parseRunArtifact((await readOrdinaryFile(join(root, 'run.json'), MAX_FILE_BYTES, root)).toString('utf8'));
  if (parsedRun.outcome !== 'violation' || !parsedRun.failure || !parsedRun.cleanup.complete
      || parsedRun.scenario !== manifest.scenario.name
      || parsedRun.failure.fingerprint !== manifest.recordedRun.failureFingerprint) {
    throw new Error('Recorded run does not match the regression manifest');
  }
  const recordedSource = requireRecordedSource(parsedRun);
  assertRecordedIdentityHashes(recordedSource);
  assertRecordedApplication(recordedSource, manifest.files);
  if (manifest.scenario.entry !== `app/${recordedSource.entry}`
      || manifest.scenario.sourceFingerprint !== recordedSource.components.source.fingerprint
      || manifest.runtime.fingerprint !== recordedSource.components.runtime.fingerprint) {
    throw new Error('Regression manifest does not match the recorded source/runtime identity');
  }
  verifyPackedRuntime(await readOrdinaryFile(join(root, manifest.runtime.package), MAX_FILE_BYTES, root), recordedSource, manifest.runtime);
  validatePackageLock(
    await readOrdinaryFile(join(root, 'app/package.json'), MAX_FILE_BYTES, root),
    await readOrdinaryFile(join(root, 'app/package-lock.json'), MAX_FILE_BYTES, root), undefined, !!manifest.installation,
  );
  if (manifest.installation) {
    const archives = new Map<string, Buffer>();
    for (const file of manifest.files.filter(file => file.role === 'dependency-archive' || file.role === 'interleave-runtime')) archives.set(file.path, await readOrdinaryFile(join(root, file.path), MAX_FILE_BYTES, root));
    verifySharedArchives(await readOrdinaryFile(join(root, 'app/package-lock.json'), MAX_FILE_BYTES, root), recordedSource, manifest.installation, archives);
    if (manifest.installation.packages.find(item => item.lockPath === SHARED_RUNTIME)?.archive !== manifest.runtime.package) throw new Error('Shared runtime archive does not match the original lock binding');
    const expected = Buffer.from(sharedInstallerSource(installerConfig(recordedSource, manifest.files, manifest.installation)));
    if (!expected.equals(await readOrdinaryFile(join(root, 'install.mjs'), MAX_FILE_BYTES, root))) throw new Error('Shared installer does not match its verified archive and source contract');
    await validateLockedTree(join(root, 'app'));
    return manifest;
  }
  if (recordedSource.sharedPackages.length) throw new Error('Shared package instances require the shared app installation profile');
  const runtimePackageBytes = await readOrdinaryFile(join(root, 'package.json'), MAX_FILE_BYTES, root);
  const runtimeLockBytes = await readOrdinaryFile(join(root, 'package-lock.json'), MAX_FILE_BYTES, root);
  validatePackageLock(runtimePackageBytes, runtimeLockBytes, manifest.runtime.package);
  validateRuntimeBinding(runtimeLockBytes, {
    name: manifest.runtime.name,
    version: manifest.runtime.version,
    bytes: await readOrdinaryFile(join(root, manifest.runtime.package), MAX_FILE_BYTES, root),
  });
  const runtimePackage = jsonObject(runtimePackageBytes, 'Runtime installation package');
  if (JSON.stringify(runtimePackage) !== JSON.stringify(runtimeInstallationPackage(manifest.runtime.package))) {
    throw new Error('Runtime installation manifest does not match the declared bundled runtime');
  }
  await validateLockedTree(join(root, 'app'));
  await validateLockedTree(root);
  return manifest;
}

function installerConfig(source: SourceIdentity, files: RegressionFile[], installation: SharedInstallation) {
  return { files: files.filter(file => file.path !== 'install.mjs').map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    archives: [...new Set(installation.packages.map(item => item.archive))].sort(), sourceFingerprint: source.fingerprint, entry: source.entry, includes: source.includes };
}

function requireRecordedSource(run: RunResult): SourceIdentity {
  const source = run.environment.source;
  if (!source) throw new Error('Export requires a recorded file source identity; record the scenario with the built CLI first');
  if (source.components.runtime.mode !== 'build') throw new Error('Source-mode recordings cannot be exported as a built runtime. Build Interleave, then record again with the built CLI (node dist/cli.js run ...)');
  return source;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

function assertSameSourceIdentity(recorded: SourceIdentity, actual: SourceIdentity): void {
  if (stableJson(recorded) !== stableJson(actual)) throw new Error('Selected source, installed dependencies, or built runtime changed from the recorded source identity');
}

function assertRecordedApplication(source: SourceIdentity, files: RegressionFile[]): void {
  const selected = files.filter(file => file.path.startsWith('app/'))
    .map(({ path, bytes, sha256 }) => ({ path: path.slice(4), bytes, sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (stableJson(selected) !== stableJson(source.components.source.files)) {
    throw new Error('Copied application files do not match the recorded source manifest');
  }
}

function assertRecordedIdentityHashes(source: SourceIdentity): void {
  const hash = (value: unknown) => digest(Buffer.from(JSON.stringify(value)));
  const files = (values: SourceIdentityFile[]) => {
    const selected = values.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    return { files: selected, fingerprint: hash(selected), fileCount: selected.length, byteCount: selected.reduce((total, file) => total + file.bytes, 0) };
  };
  const edge = (value: SourceIdentity['components']['dependencies']['roots'][number]) => ({
    name: value.name,
    ...(value.packageId === undefined ? {} : { packageId: value.packageId }),
    ...(value.optional ? { optional: true as const } : {}),
    ...(value.missing ? { missing: true as const } : {}),
    ...(value.from === undefined ? {} : { from: value.from }),
  });
  const graph = (value: SourceIdentity['components']['dependencies']) => {
    const roots = value.roots.map(edge);
    const packages = value.packages.map(pkg => ({ id: pkg.id, name: pkg.name, version: pkg.version, ...files(pkg.files), dependencies: pkg.dependencies.map(edge) }));
    return { fingerprint: hash({ roots, packages }), roots, packages,
      fileCount: packages.reduce((total, pkg) => total + pkg.fileCount, 0), byteCount: packages.reduce((total, pkg) => total + pkg.byteCount, 0) };
  };
  const sourceFiles = files(source.components.source.files);
  const dependencies = graph(source.components.dependencies);
  const runtimeFiles = files(source.components.runtime.files);
  const runtimeDependencies = graph(source.components.runtime.dependencies);
  const runtime = { ...runtimeFiles, mode: source.components.runtime.mode, dependencies: runtimeDependencies,
    fingerprint: hash({ mode: source.components.runtime.mode, files: runtimeFiles.files, dependencies: runtimeDependencies.fingerprint }),
    fileCount: runtimeFiles.fileCount + runtimeDependencies.fileCount, byteCount: runtimeFiles.byteCount + runtimeDependencies.byteCount };
  const selected = { entry: source.entry, includes: source.includes,
    sharedPackages: source.sharedPackages.map(({ dependencyPackageId, runtimePackageId }) => ({ dependencyPackageId, runtimePackageId })),
    components: { source: sourceFiles, dependencies, runtime } };
  const expected = { version: 1, profile: 'node-source-v1', algorithm: 'sha256',
    fingerprint: hash({ version: 1, profile: 'node-source-v1', ...selected }), ...selected,
    fileCount: sourceFiles.fileCount + dependencies.fileCount + runtime.fileCount,
    byteCount: sourceFiles.byteCount + dependencies.byteCount + runtime.byteCount };
  if (stableJson(expected) !== stableJson(source)) throw new Error('Recorded source identity hashes do not match their manifests');
}

function verifyPackedRuntime(bytes: Buffer, source: SourceIdentity, runtime: { name: string; version: string }): void {
  const archive = readRuntimeArchive(bytes);
  const metadata = jsonObject(archive.get('package.json') ?? Buffer.alloc(0), 'Packed runtime package metadata');
  assertUnbundledRuntime(metadata);
  if (metadata.name !== runtime.name || metadata.version !== runtime.version) throw new Error('Packed runtime metadata does not match its bound package');
  const selected: SourceIdentityFile[] = [];
  for (const [path, data] of archive) {
    const parts = path.split('/');
    if (['src', 'dist'].includes(parts[0]!) && parts.includes('node_modules')) {
      throw new Error('Packed Interleave runtime src/dist node_modules entries are unsupported dependency shadows');
    }
    if (path === 'package.json' || (path.startsWith('dist/') && path.endsWith('.js')
        && !parts.some(part => ['report', 'cli', 'examples', 'vendor', 'node_modules'].includes(part)))) {
      selected.push({ path, bytes: data.length, sha256: digest(data) });
    }
  }
  selected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (stableJson(selected) !== stableJson(source.components.runtime.files)) {
    throw new Error('Packed runtime archive does not contain exactly the recorded runtime implementation bytes');
  }
}

function assertUnbundledRuntime(metadata: Record<string, unknown>): void {
  for (const key of ['bundleDependencies', 'bundledDependencies']) {
    const value = metadata[key];
    if (value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)) {
      throw new Error('Bundled runtime dependencies are unsupported by the separate-install export profile');
    }
  }
}

/** Bounded ordinary-file npm tar profile. Nothing is extracted or executed. */

async function addScenarioGraph(
  root: string,
  source: string,
  selected: Map<string, SelectedFile>,
  visited: Set<string>,
  entry: boolean,
): Promise<void> {
  if (visited.has(source)) return;
  visited.add(source);
  const output = bundlePath(root, source);
  const bytes = await readOrdinaryFile(source, MAX_FILE_BYTES, root);
  selected.set(output, { source, output, role: entry ? 'scenario' : 'application-source', bytes });
  assertSelectionBounds(selected);
  const packageScope = await addPackageScopes(root, source, selected);
  if (extname(source) === '.json') return;
  const text = decodeUtf8(bytes, `Scenario source ${relative(root, source)}`);
  const { inspectSourceModule } = await import('./export-source.js');
  const inspected = inspectSourceModule(text, relative(root, source));
  if (inspected.unsupported.length) throw new Error(`Unsupported source loading in ${relative(root, source)}: ${inspected.unsupported.join('; ')}`);
  for (const { specifier, kind, typeOnly } of inspected.imports) {
    if (typeOnly) continue;
    if (!specifier.startsWith('.')) {
      if (typeof packageScope?.name === 'string' && packageScope.exports !== undefined
          && (specifier === packageScope.name || specifier.startsWith(`${packageScope.name}/`))) {
        throw new Error(`Unsupported package self-reference ${JSON.stringify(specifier)} in ${relative(root, source)}; use a literal relative file import`);
      }
      if (specifier.startsWith('/') || specifier.startsWith('file:') || specifier.startsWith('#')) {
        throw new Error(`Unsupported non-relative local import ${JSON.stringify(specifier)} in ${relative(root, source)}`);
      }
      continue;
    }
    const imported = await resolveRelativeImport(root, source, specifier, kind);
    await addScenarioGraph(root, imported, selected, visited, false);
  }
}

async function addPackageScopes(root: string, source: string, selected: Map<string, SelectedFile>): Promise<Record<string, unknown> | undefined> {
  let nearest: Record<string, unknown> | undefined;
  for (let directory = dirname(source); ; directory = dirname(directory)) {
    assertInside(root, directory, 'Module package scope');
    const path = join(directory, 'package.json');
    const stats = await lstat(path).catch((error: unknown) => hasCode(error, 'ENOENT') ? undefined : Promise.reject(error));
    if (stats) {
      const output = bundlePath(root, path);
      await addSelectedFile(root, path, output, 'application-source', selected);
      nearest ??= jsonObject(selected.get(output)!.bytes, 'Module package scope');
    }
    if (directory === root) return nearest;
  }
}

async function addInclude(root: string, source: string, selected: Map<string, SelectedFile>): Promise<void> {
  await assertNoSymlinkComponents(root, source);
  const stats = await lstat(source).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) throw new Error(`Selected include does not exist: ${relative(root, source)}`);
    throw error;
  });
  if (stats.isSymbolicLink()) throw new Error(`Refusing symbolic link include: ${relative(root, source)}`);
  if (stats.isFile()) {
    await addSelectedFile(root, source, bundlePath(root, source), 'application-source', selected);
    return;
  }
  if (!stats.isDirectory()) throw new Error(`Selected include must be a file or directory: ${relative(root, source)}`);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in selected source: ${relative(root, join(source, entry.name))}`);
    await addInclude(root, join(source, entry.name), selected);
  }
}

async function addSelectedFile(
  root: string,
  source: string,
  output: string,
  role: RegressionFileRole,
  selected: Map<string, SelectedFile>,
): Promise<void> {
  const existing = selected.get(output);
  if (existing) {
    if (role === 'package-manifest' || role === 'dependency-lock') existing.role = role;
    return;
  }
  const bytes = await readOrdinaryFile(source, MAX_FILE_BYTES, root);
  selected.set(output, { source, output, role, bytes });
  assertSelectionBounds(selected);
}

function assertSelectionBounds(selected: Map<string, SelectedFile>): void {
  if (selected.size > MAX_FILES) throw new Error(`Regression export exceeds the ${MAX_FILES} file limit`);
  const total = [...selected.values()].reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error('Selected application source exceeds the 128 MiB export limit');
}

async function writeCopiedFile(root: string, file: SelectedFile, records: RegressionFile[]): Promise<void> {
  const sourceNow = await readOrdinaryFile(file.source, MAX_FILE_BYTES);
  if (!sourceNow.equals(file.bytes)) throw new Error(`Selected source changed while it was being exported: ${file.source}`);
  await writeGeneratedFile(root, file.output, file.role, file.bytes, records);
}

async function writeGeneratedFile(
  root: string,
  output: string,
  role: RegressionFileRole,
  bytes: Buffer,
  records: RegressionFile[],
): Promise<void> {
  const destination = join(root, ...output.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await assertNoSymlinkComponents(root, dirname(destination));
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  const copied = await readOrdinaryFile(destination, MAX_FILE_BYTES, root);
  if (!copied.equals(bytes)) throw new Error(`Copied file failed immediate verification: ${output}`);
  records.push(fileRecord(output, role, bytes));
}

async function packRuntime(runtimeRoot: string, staging: string): Promise<RuntimePackage> {
  const metadataBytes = await readOrdinaryFile(join(runtimeRoot, 'package.json'), MAX_FILE_BYTES, runtimeRoot);
  const metadata = jsonObject(metadataBytes, 'Interleave runtime package.json');
  const name = requiredString(metadata.name, 'Interleave runtime package name');
  const version = requiredString(metadata.version, 'Interleave runtime package version');
  if (name !== '@pavangupta352/interleave') throw new TypeError(`Unexpected Interleave runtime package name: ${name}`);
  const runtimeDirectory = join(staging, 'runtime');
  await mkdir(runtimeDirectory);
  const result = await runCommand(npmExecutable(), [
    'pack', '--ignore-scripts', '--json', '--pack-destination', runtimeDirectory,
  ], runtimeRoot);
  let packed: unknown;
  try { packed = JSON.parse(result.stdout); }
  catch { throw new Error(`npm pack did not return JSON metadata${result.stderr ? `: ${result.stderr.trim()}` : ''}`); }
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0] !== 'object' || packed[0] === null) {
    throw new Error('npm pack returned unexpected package metadata');
  }
  const record = packed[0] as Record<string, unknown>;
  if (record.name !== name || record.version !== version) throw new Error('Interleave runtime metadata changed during npm pack');
  const filename = requiredString(record.filename, 'npm pack filename');
  if (basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error('npm pack returned an unsafe filename');
  const listed = Array.isArray(record.files)
    ? record.files.flatMap((item) => typeof item === 'object' && item !== null && typeof (item as { path?: unknown }).path === 'string'
      ? [(item as { path: string }).path]
      : [])
    : [];
  for (const required of ['package.json', 'dist/cli.js', 'dist/export.js', 'dist/index.js']) {
    if (!listed.includes(required)) throw new Error(`Interleave runtime package is missing ${required}; build the package before exporting`);
  }
  const path = join(runtimeDirectory, filename);
  const bytes = await readOrdinaryFile(path, MAX_FILE_BYTES, staging);
  return { path, relativePath: `runtime/${filename}`, name, version, bytes };
}

function parseManifest(bytes: Buffer): RegressionManifest {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Regression manifest exceeds the 2 MiB size limit');
  const root = jsonObject(bytes, 'Regression manifest');
  exactKeys(root, [
    'schemaVersion', 'kind', 'createdAt', 'fingerprint', 'scenario', 'recordedRun',
    'project', 'runtime', 'files', 'replay', ...(root.installation === undefined ? [] : ['installation']),
  ], 'Regression manifest');
  if (root.schemaVersion !== 1 || root.kind !== 'interleave-regression') throw new TypeError('Unsupported regression manifest');
  const createdAt = requiredString(root.createdAt, 'Regression manifest createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError('Regression manifest createdAt must be an ISO timestamp');
  const fingerprint = hashValue(root.fingerprint, 'Regression manifest fingerprint');
  const scenario = exactObject(root.scenario, ['name', 'entry', 'sourceFingerprint'], 'scenario');
  const recordedRun = exactObject(root.recordedRun, ['path', 'outcome', 'failureFingerprint'], 'recordedRun');
  const project = exactObject(root.project, ['package', 'lock'], 'project');
  const runtime = exactObject(root.runtime, ['package', 'name', 'version', 'fingerprint'], 'runtime');
  const replayObject = exactObject(root.replay, ['install', 'command'], 'replay');
  const entry = safeBundlePath(scenario.entry, 'scenario.entry');
  if (!entry.startsWith('app/')) throw new TypeError('scenario.entry must be inside app/');
  if (recordedRun.path !== 'run.json' || recordedRun.outcome !== 'violation') throw new TypeError('recordedRun must identify run.json violation evidence');
  if (project.package !== 'app/package.json' || project.lock !== 'app/package-lock.json') throw new TypeError('project must identify the copied npm manifest and lock');
  const installation = root.installation === undefined ? undefined : parseSharedInstallation(root.installation);
  const runtimePath = safeBundlePath(runtime.package, 'runtime.package');
  if (!runtimePath.startsWith(installation ? 'archives/' : 'runtime/') || !runtimePath.endsWith('.tgz')) throw new TypeError('runtime.package must identify a bundled tarball');
  if (!Array.isArray(root.files) || root.files.length > MAX_FILES) throw new TypeError('files must be a bounded array');
  const files = root.files.map((value, index) => {
    const file = exactObject(value, ['path', 'role', 'bytes', 'sha256'], `files[${index}]`);
    const path = safeBundlePath(file.path, `files[${index}].path`);
    const roles: RegressionFileRole[] = ['scenario', 'application-source', 'package-manifest', 'dependency-lock', 'runtime-manifest', 'runtime-lock', 'run-artifact', 'interleave-runtime', 'dependency-archive', 'installer'];
    if (!roles.includes(file.role as RegressionFileRole)) throw new TypeError(`files[${index}].role is invalid`);
    if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > MAX_FILE_BYTES) throw new TypeError(`files[${index}].bytes is invalid`);
    return { path, role: file.role as RegressionFileRole, bytes: file.bytes as number, sha256: hashValue(file.sha256, `files[${index}].sha256`) };
  });
  if (files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)) {
    throw new TypeError('Regression manifest file paths must be unique and sorted');
  }
  const install = commandList(replayObject.install, 'replay.install');
  const replayCommand = command(replayObject.command, 'replay.command');
  const expectedInstall: RegressionManifest['replay']['install'] = installation ? [['node', 'install.mjs']] : [
    ['npm', 'ci', '--prefix', 'app'],
    ['npm', 'ci'],
  ];
  const expectedCommand: RegressionManifest['replay']['command'] = [
    'node', `${installation ? 'app/' : ''}node_modules/@pavangupta352/interleave/dist/cli.js`, 'replay', entry, 'run.json', '--project-root', 'app',
  ];
  if (JSON.stringify(install) !== JSON.stringify(expectedInstall)
      || JSON.stringify(replayCommand) !== JSON.stringify(expectedCommand)) {
    throw new TypeError('replay commands must exactly match the declared runtime, scenario, and artifact paths');
  }
  return {
    schemaVersion: 1,
    kind: 'interleave-regression',
    createdAt,
    fingerprint,
    scenario: {
      name: requiredString(scenario.name, 'scenario.name'),
      entry,
      sourceFingerprint: hashValue(scenario.sourceFingerprint, 'scenario.sourceFingerprint'),
    },
    recordedRun: {
      path: 'run.json',
      outcome: 'violation',
      failureFingerprint: hashValue(recordedRun.failureFingerprint, 'recordedRun.failureFingerprint'),
    },
    project: { package: 'app/package.json', lock: 'app/package-lock.json' },
    runtime: {
      package: runtimePath,
      name: requiredString(runtime.name, 'runtime.name'),
      version: requiredString(runtime.version, 'runtime.version'),
      fingerprint: hashValue(runtime.fingerprint, 'runtime.fingerprint'),
    },
    files,
    ...(installation ? { installation } : {}),
    replay: { install, command: replayCommand },
  };
}

function validatePackageLock(packageBytes: Buffer, lockBytes: Buffer, runtimeTarball?: string, shared = false): void {
  const packageJson = jsonObject(packageBytes, 'Selected package.json');
  const lock = jsonObject(lockBytes, 'Selected package-lock.json');
  const name = requiredString(packageJson.name, 'Selected package name');
  if (lock.name !== name) throw new TypeError('package-lock.json name does not match package.json');
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) throw new TypeError('package-lock.json must use lockfileVersion 2 or 3');
  const packages = plainObject(lock.packages, 'package-lock.json packages');
  const lockRoot = plainObject(packages[''], 'package-lock.json root package');
  if (lockRoot.name !== undefined && lockRoot.name !== name) throw new TypeError('package-lock.json root package name does not match package.json');
  if (packageJson.version !== undefined && lock.version !== packageJson.version) throw new TypeError('package-lock.json version does not match package.json');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const wanted = Object.entries(plainObject(packageJson[section] ?? {}, `package.json ${section}`)).sort();
    const locked = Object.entries(plainObject(lockRoot[section] ?? {}, `package-lock.json ${section}`)).sort();
    if (JSON.stringify(wanted) !== JSON.stringify(locked)) throw new Error(`package-lock.json ${section} does not match package.json`);
  }
  if (packageJson.workspaces !== undefined) throw new Error('Workspace dependency locks are unsupported for portable exports');
  for (const [path, value] of Object.entries(packages)) {
    if (!path) continue;
    safeBundlePath(path, 'Locked dependency path');
    const dependency = plainObject(value, `Locked dependency ${path}`);
    if (dependency.link === true) throw new Error(`Linked/local dependency is unsupported in portable lock: ${path}`);
    if (dependency.inBundle === true) continue;
    const resolved = requiredString(dependency.resolved, `Locked dependency ${path} resolved`);
    if (!(runtimeTarball && path === 'node_modules/@pavangupta352/interleave' && resolved === `file:${runtimeTarball}`)
        && !(shared && resolved.startsWith('file:')) && !/^https?:\/\//.test(resolved)) {
      throw new Error(`Only integrity-pinned registry/tarball dependencies are supported in portable locks: ${path}`);
    }
    if (typeof dependency.integrity !== 'string' || !/^(?:sha512|sha384|sha256|sha1)-[A-Za-z0-9+/=]+(?:\s+(?:sha512|sha384|sha256|sha1)-[A-Za-z0-9+/=]+)*$/.test(dependency.integrity)) {
      throw new Error(`Locked dependency is missing a supported integrity digest: ${path}`);
    }
  }
}

async function validateLockedTree(directory: string): Promise<void> {
  // npm's virtual-tree validator reads package/lock data; it does not install
  // dependencies or execute application lifecycle scripts.
  await runCommand(npmExecutable(), ['ls', '--package-lock-only', '--all', '--json', '--ignore-scripts', '--include=dev', '--include=optional', '--include=peer'], directory);
}

function runtimeInstallationPackage(tarball: string): Record<string, unknown> {
  return { name: 'interleave-regression-runtime', version: '1.0.0', private: true, dependencies: { '@pavangupta352/interleave': `file:${tarball}` } };
}

async function createRuntimeLock(root: string, runtime: RuntimePackage, records: RegressionFile[]): Promise<void> {
  const metadata = Buffer.from(`${JSON.stringify(runtimeInstallationPackage(runtime.relativePath), null, 2)}\n`);
  await writeGeneratedFile(root, 'package.json', 'runtime-manifest', metadata, records);
  await runCommand(npmExecutable(), ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], root);
  const lock = await readOrdinaryFile(join(root, 'package-lock.json'), MAX_FILE_BYTES, root);
  validatePackageLock(metadata, lock, runtime.relativePath);
  validateRuntimeBinding(lock, runtime);
  records.push(fileRecord('package-lock.json', 'runtime-lock', lock));
}

function validateRuntimeBinding(lock: Buffer, runtime: Pick<RuntimePackage, 'name' | 'version' | 'bytes'>): void {
  const parsed = jsonObject(lock, 'Runtime dependency lock');
  const dependency = plainObject(plainObject(parsed.packages, 'Runtime lock packages')['node_modules/@pavangupta352/interleave'], 'Locked Interleave runtime');
  if (runtime.name !== '@pavangupta352/interleave' || dependency.version !== runtime.version || dependency.integrity !== `sha512-${createHash('sha512').update(runtime.bytes).digest('base64')}`) {
    throw new Error('Runtime lock does not identify the bundled runtime bytes and version');
  }
}

async function resolveRelativeImport(root: string, importer: string, specifier: string, kind: 'import' | 'require'): Promise<string> {
  let base: string;
  if (kind === 'import') {
    const url = new URL(specifier, pathToFileURL(importer));
    if (url.search || url.hash) throw new Error(`Relative import must not contain a query or fragment: ${specifier}`);
    // fileURLToPath follows Node's URL decoding, including rejecting encoded separators.
    base = fileURLToPath(url);
  } else {
    // CommonJS treats percent signs and other filename characters literally.
    base = resolve(dirname(importer), specifier);
  }
  assertInside(root, base, `Relative import ${specifier}`);
  if (kind === 'require' && specifier.endsWith('/')) {
    throw new Error(`Directory module resolution is unsupported for portable export: ${specifier}; use an explicit file path`);
  }
  const candidates = [base];
  if (kind === 'require') {
    for (const extension of ['.js', '.json', '.node']) candidates.push(`${base}${extension}`);
  }
  let directory = false;
  for (const candidate of candidates) {
    const stats = await lstat(candidate).catch((error: unknown) => hasCode(error, 'ENOENT') ? undefined : Promise.reject(error));
    if (!stats) continue;
    if (stats.isSymbolicLink()) throw new Error(`Refusing symbolic link relative import: ${relative(root, candidate)}`);
    if (candidate === base && stats.isDirectory()) directory = true;
    if (stats.isFile()) {
      if (extname(candidate) === '.node') throw new Error(`Native module imports are unsupported for portable export: ${specifier}`);
      return candidate;
    }
  }
  if (directory) throw new Error(`Directory module resolution is unsupported for portable export: ${specifier}; use an explicit file path`);
  throw new Error(`Relative ${kind} ${JSON.stringify(specifier)} from ${relative(root, importer)} could not be resolved with standalone Node module rules`);
}

async function listBundleFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Regression folder contains a symbolic link: ${relative(root, path)}`);
    if (entry.isDirectory()) files.push(...await listBundleFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    else throw new Error(`Regression folder contains a non-file entry: ${relative(root, path)}`);
    if (files.length > MAX_FILES + 1) throw new Error('Regression folder exceeds the file limit');
  }
  return files.sort();
}


async function ordinaryDirectory(path: string, label: string): Promise<string> {
  const value = resolveRequired(path, label);
  const stats = await lstat(value).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) throw new Error(`${label} does not exist: ${value}`);
    throw error;
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label} must be an ordinary directory: ${value}`);
  return realpath(value);
}


function selectedPath(root: string, value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) throw new TypeError(`${label} must be a non-empty path relative to projectRoot`);
  const path = resolve(root, value);
  assertInside(root, path, label);
  return path;
}

function bundlePath(root: string, source: string): string {
  return `app/${relative(root, source).split(sep).join('/')}`;
}



async function assertAbsent(path: string): Promise<void> {
  const stats = await lstat(path).catch((error: unknown) => hasCode(error, 'ENOENT') ? undefined : Promise.reject(error));
  if (stats) throw new Error(`Regression destination already exists and will not be overwritten: ${path}`);
}

function resolveRequired(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be an explicit non-empty path`);
  return resolve(value);
}

function fileRecord(path: string, role: RegressionFileRole, bytes: Buffer): RegressionFile {
  return { path, role, bytes: bytes.length, sha256: digest(bytes) };
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestFingerprint(value: object): string {
  return digest(Buffer.from(JSON.stringify(value), 'utf8'));
}


function jsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(decodeUtf8(bytes, label)); }
  catch (error) {
    if (error instanceof TypeError && /UTF-8/.test(error.message)) throw error;
    throw new TypeError(`${label} is not valid JSON`);
  }
  return plainObject(value, label);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError(`${label} contains a prototype-sensitive key`);
  }
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  const object = plainObject(value, label);
  exactKeys(object, keys, label);
  return object;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains missing or unknown fields`);
  }
}


function hashValue(value: unknown, label: string): string {
  const hash = requiredString(value, label);
  if (!HASH.test(hash)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  return hash;
}

function commandList(value: unknown, label: string): [string, ...string[]][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new TypeError(`${label} must be a bounded command list`);
  return value.map((entry, index) => command(entry, `${label}[${index}]`));
}

function command(value: unknown, label: string): [string, ...string[]] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new TypeError(`${label} must be a non-empty argument array`);
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`)) as [string, ...string[]];
}

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const stop = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      child.kill('SIGKILL');
    };
    const deadline = setTimeout(() => stop(`Command deadline exceeded: ${command} ${args[0] ?? ''}`), 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 1024 * 1024) stop(`Command output exceeds 1 MiB: ${command}`);
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (failure) return;
      if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 1024 * 1024) stop(`Command output exceeds 1 MiB: ${command}`);
      else stderr += chunk;
    });
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (failure) reject(failure);
      else if (code === 0) resolveCommand({ stdout, stderr });
      else reject(new Error(`Command failed: ${command} ${args[0] ?? ''}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}
