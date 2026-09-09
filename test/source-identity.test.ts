import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs, { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { captureSourceIdentity, SourceIdentityError } from '../src/source-identity.js';

const roots: string[] = [];
async function temporary() { const root = await realpath(await mkdtemp(join(tmpdir(), 'interleave source identity '))); roots.push(root); return root; }
const json = (path: string, data: unknown) => writeFile(path, JSON.stringify(data));
async function project() {
  const root = await temporary();
  await json(join(root, 'package.json'), { name: 'identity-fixture', version: '1.0.0', type: 'module' });
  await json(join(root, 'package-lock.json'), { name: 'identity-fixture', lockfileVersion: 3, packages: {} });
  await writeFile(join(root, 'scenario.mjs'), "import{value}from'./helper.mjs';globalThis.__identityExecuted=true;export default value;");
  await writeFile(join(root, 'helper.mjs'), 'export const value=42;');
  return root;
}
async function dependency(root: string, name: string, version = '1.0.0', dependencies: Record<string, string> = {}) {
  const directory = join(root, 'node_modules', name); await mkdir(directory, { recursive: true });
  await json(join(directory, 'package.json'), { name, version, main: 'index.js', dependencies });
  await writeFile(join(directory, 'index.js'), `throw new Error('dependency must not execute');`);
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test('captures portable local source, manifests, and explicit data without executing code', async () => {
  const root = await project(); await mkdir(join(root, 'data')); await writeFile(join(root, 'data/seed.sql'), 'SELECT 42;');
  const captured = await captureSourceIdentity(join(root, 'scenario.mjs'), { include: ['data'] });
  expect(captured.components.source.files.map(file => file.path)).toEqual(['data/seed.sql', 'helper.mjs', 'package-lock.json', 'package.json', 'scenario.mjs']);
  expect(captured.entry).toBe('scenario.mjs'); expect(captured.algorithm).toBe('sha256');
  expect(captured.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect('__identityExecuted' in globalThis).toBe(false);
  expect(JSON.stringify(captured)).not.toContain(root);
  const copied = await temporary(); await cp(root, copied, { recursive: true });
  expect((await captureSourceIdentity(join(copied, 'scenario.mjs'), { include: ['data'] })).fingerprint).toBe(captured.fingerprint);
});

test.each(['helper.mjs', 'package.json', 'package-lock.json', 'seed.json'])('captures changed %s bytes independently of lock names or versions', async path => {
  const root = await project(); await writeFile(join(root, 'seed.json'), '{}');
  const before = await captureSourceIdentity(join(root, 'scenario.mjs'), { include: ['seed.json'] });
  await writeFile(join(root, path), `${await readFile(join(root, path), 'utf8')}\n`);
  const after = await captureSourceIdentity(join(root, 'scenario.mjs'), { include: ['seed.json'] });
  expect(after.components.source.fingerprint).not.toBe(before.components.source.fingerprint);
});

test('supports a standalone scenario without requiring an npm lock or package', async () => {
  const root = await temporary(); await writeFile(join(root, 'scenario.mjs'), "import assert from 'node:assert/strict';export default 1;");
  const result = await captureSourceIdentity(join(root, 'scenario.mjs'));
  expect(result.components.source.files.map(file => file.path)).toEqual(['scenario.mjs']);
});

test('captures modified installed dependencies, scoped packages, nested duplicates, and cycles', async () => {
  const root = await project(); await writeFile(join(root, 'scenario.mjs'), "import a from '@scope/a';import b from 'b';export default [a,b];");
  const a = await dependency(root, '@scope/a', '1.0.0', { shared: '1.0.0' });
  const b = await dependency(root, 'b', '1.0.0', { shared: '2.0.0' });
  await dependency(a, 'shared', '1.0.0', { '@scope/a': '1.0.0' });
  const shared = await dependency(b, 'shared', '2.0.0');
  const before = await captureSourceIdentity(join(root, 'scenario.mjs'));
  expect(before.components.dependencies.packages.filter(pkg => pkg.name === 'shared').map(pkg => pkg.version).sort()).toEqual(['1.0.0', '2.0.0']);
  await writeFile(join(shared, 'index.js'), 'module.exports=999;');
  const after = await captureSourceIdentity(join(root, 'scenario.mjs'));
  expect(after.components.dependencies.fingerprint).not.toBe(before.components.dependencies.fingerprint);
  expect(after.components.source.fingerprint).toBe(before.components.source.fingerprint);
  const copied = await temporary(); await cp(root, copied, { recursive: true });
  expect((await captureSourceIdentity(join(copied, 'scenario.mjs'))).fingerprint).toBe(after.fingerprint);
});

function executeCommonJs(file: string): string {
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

test('CJS directory main uses Node file/index fallback without a second package-main lookup', async () => {
  const root = await temporary();
  await json(join(root, 'package.json'), { name: 'directory-main-fixture', version: '1.0.0', type: 'commonjs' });
  await mkdir(join(root, 'outer/inner'), { recursive: true });
  await json(join(root, 'outer/package.json'), { main: './inner' });
  await json(join(root, 'outer/inner/package.json'), { main: './alternate.js' });
  await writeFile(join(root, 'outer/inner/alternate.js'), 'module.exports=99;');
  await writeFile(join(root, 'outer/inner/index.js'), 'module.exports=41;');
  const entry = join(root, 'scenario.cjs');
  await writeFile(entry, "console.log(require('./outer'));");
  expect(executeCommonJs(entry)).toBe('41');
  const before = await captureSourceIdentity(entry);
  expect(before.components.source.files.map(file => file.path)).toContain('outer/inner/index.js');
  expect(before.components.source.files.map(file => file.path)).not.toContain('outer/inner/alternate.js');
  await writeFile(join(root, 'outer/inner/index.js'), 'module.exports=42;');
  expect(executeCommonJs(entry)).toBe('42');
  expect((await captureSourceIdentity(entry)).components.source.fingerprint).not.toBe(before.components.source.fingerprint);
});

test.each(['./helper/', './helper/.', './helper/inner/..'])('CJS directory request %s selects its index even when an extension sibling exists', async request => {
  const root = await temporary();
  await json(join(root, 'package.json'), { name: 'directory-slash-fixture', version: '1.0.0', type: 'commonjs' });
  await mkdir(join(root, 'helper/inner'), { recursive: true });
  await writeFile(join(root, 'helper.js'), 'module.exports=99;');
  await writeFile(join(root, 'helper/index.js'), 'module.exports=61;');
  const entry = join(root, 'scenario.cjs');
  await writeFile(entry, `console.log(require(${JSON.stringify(request)}));`);
  expect(executeCommonJs(entry)).toBe('61');
  const before = await captureSourceIdentity(entry);
  expect(before.components.source.files.map(file => file.path)).toContain('helper/index.js');
  expect(before.components.source.files.map(file => file.path)).not.toContain('helper.js');
  await writeFile(join(root, 'helper/index.js'), 'module.exports=62;');
  expect(executeCommonJs(entry)).toBe('62');
  expect((await captureSourceIdentity(entry)).components.source.fingerprint).not.toBe(before.components.source.fingerprint);
});

test.each(['./missing', './index.js/missing'])('CJS invalid package main %s falls back to the original directory index like Node', async main => {
  const root = await temporary();
  await json(join(root, 'package.json'), { name: 'directory-fallback-fixture', version: '1.0.0', type: 'commonjs' });
  await mkdir(join(root, 'helper'));
  await json(join(root, 'helper/package.json'), { main });
  await writeFile(join(root, 'helper/index.js'), 'module.exports=71;');
  const entry = join(root, 'scenario.cjs');
  await writeFile(entry, "console.log(require('./helper'));");
  expect(executeCommonJs(entry)).toBe('71');
  expect((await captureSourceIdentity(entry)).components.source.files.map(file => file.path)).toContain('helper/index.js');
});

test('installed dependency search skips node_modules/node_modules like Node', async () => {
  const root = await project();
  const entry = join(root, 'scenario.cjs');
  await writeFile(entry, "console.log(require('a'));");
  const a = await dependency(root, 'a', '1.0.0', { b: '*' });
  const actual = await dependency(root, 'b', '1.0.0');
  const skipped = await dependency(join(root, 'node_modules'), 'b', '2.0.0');
  await writeFile(join(a, 'index.js'), "module.exports=require('b');");
  await writeFile(join(actual, 'index.js'), 'module.exports=51;');
  await writeFile(join(skipped, 'index.js'), 'module.exports=99;');
  expect(executeCommonJs(entry)).toBe('51');
  const before = await captureSourceIdentity(entry);
  expect(before.components.dependencies.packages.map(pkg => [pkg.name, pkg.version])).toEqual([['a', '1.0.0'], ['b', '1.0.0']]);
  await writeFile(join(actual, 'index.js'), 'module.exports=52;');
  expect(executeCommonJs(entry)).toBe('52');
  expect((await captureSourceIdentity(entry)).components.dependencies.fingerprint).not.toBe(before.components.dependencies.fingerprint);
});

test('captures absence of optional peers and fails on missing required dependencies', async () => {
  const root = await project(); await writeFile(join(root, 'scenario.mjs'), "import 'driver';");
  const driver = await dependency(root, 'driver');
  await json(join(driver, 'package.json'), { name: 'driver', version: '1.0.0', main: 'index.js', peerDependencies: { native: '*' }, peerDependenciesMeta: { native: { optional: true } } });
  const result = await captureSourceIdentity(join(root, 'scenario.mjs'));
  expect(result.components.dependencies.packages[0]!.dependencies).toEqual([{ name: 'native', optional: true, missing: true }]);
  await json(join(driver, 'package.json'), { name: 'driver', version: '1.0.0', dependencies: { missing: '1' } });
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'unsupported' });
});

test.each([
  "const target='./helper.mjs';await import(target);",
  "import '#alias';",
  "import 'file:///outside.mjs';",
  "const r=require;r('./helper.mjs');",
  "import {createRequire} from 'node:module';const load=createRequire(import.meta.url);load('./helper.mjs');",
  "eval('import(\"./helper.mjs\")');",
  "globalThis.eval('import(\"./helper.mjs\")');",
  "process['dlopen']({}, './native.bin');",
  "import vm from 'node:vm';vm.runInThisContext('code');",
])('rejects unsupported source resolution without a partial identity: %s', async source => {
  const root = await project(); await writeFile(join(root, 'scenario.mjs'), source);
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toBeInstanceOf(SourceIdentityError);
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'unsupported' });
});

test('allows ordinary environment reads while capturing only their source bytes', async () => {
  const root = await project(); await writeFile(join(root, 'scenario.mjs'), 'export default process.env.APPLICATION_FLAG;');
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).resolves.toMatchObject({ entry: 'scenario.mjs' });
});

test('rejects local and installed dependency symlink escapes', async () => {
  const root = await project(); const outside = await temporary(); await writeFile(join(outside, 'outside.mjs'), 'export default 1;');
  await symlink(join(outside, 'outside.mjs'), join(root, 'escape.mjs')); await writeFile(join(root, 'scenario.mjs'), "import './escape.mjs';");
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'unsupported' });
  await writeFile(join(root, 'scenario.mjs'), "import 'driver';"); await mkdir(join(root, 'node_modules')); await symlink(outside, join(root, 'node_modules/driver'));
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'unsupported' });
});

test('enforces caller file/byte bounds and pre-aborted cancellation', async () => {
  const root = await project(); const file = join(root, 'scenario.mjs');
  await expect(captureSourceIdentity(file, { maxFiles: 1 })).rejects.toMatchObject({ kind: 'budget' });
  await expect(captureSourceIdentity(file, { maxBytes: 10 })).rejects.toMatchObject({ kind: 'budget' });
  await expect(captureSourceIdentity(file, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'aborted' });
});

test('binds actual runtime implementation bytes while excluding reports and build maps', async () => {
  const root = await project(); const result = await captureSourceIdentity(join(root, 'scenario.mjs'));
  expect(result.components.runtime.mode).toBe('source');
  const runner = result.components.runtime.files.find(file => file.path === 'src/runner.ts')!;
  expect(runner.sha256).toBe(createHash('sha256').update(await readFile(new URL('../src/runner.ts', import.meta.url))).digest('hex'));
  expect(result.components.runtime.files.some(file => /README|\.map$|\.d\.ts$|report\//.test(file.path))).toBe(false);
  expect(result.components.runtime.dependencies.packages.some(pkg => pkg.name === 'pg')).toBe(true);
});

test('keeps importer-to-package bindings when other importers already reference both installed copies', async () => {
  const root = await project();
  await writeFile(join(root, 'scenario.mjs'), "import './a/one.mjs';import './b/two.mjs';import './a/three.mjs';");
  await mkdir(join(root, 'a')); await mkdir(join(root, 'b'));
  await writeFile(join(root, 'a/one.mjs'), "import 'shared';");
  await writeFile(join(root, 'b/two.mjs'), "import 'shared';");
  await writeFile(join(root, 'a/three.mjs'), "import 'shared';");
  await dependency(join(root, 'a'), 'shared', '1.0.0'); await dependency(join(root, 'b'), 'shared', '2.0.0');
  const identity = await captureSourceIdentity(join(root, 'scenario.mjs'));
  expect(identity.components.dependencies.roots.filter(item => item.name === 'shared').map(item => item.from)).toEqual(['a/one.mjs', 'a/three.mjs', 'b/two.mjs']);
});

test('uses Node ESM percent decoding and CommonJS extension order, preserving package scopes', async () => {
  const root = await project();
  await writeFile(join(root, 'scenario.mjs'), "import './space%20name.mjs';import './sub/entry.cjs';");
  await writeFile(join(root, 'space name.mjs'), 'export default 42;');
  await writeFile(join(root, 'space%20name.mjs'), 'export default 999;');
  await mkdir(join(root, 'sub')); await json(join(root, 'sub/package.json'), { type: 'commonjs' });
  await writeFile(join(root, 'sub/entry.cjs'), "module.exports=require('./helper');");
  await writeFile(join(root, 'sub/helper.js'), 'module.exports=42;');
  await writeFile(join(root, 'sub/helper.mjs'), 'export default 999;');
  const captured = await captureSourceIdentity(join(root, 'scenario.mjs'));
  const paths = captured.components.source.files.map(item => item.path);
  expect(paths).toContain('space name.mjs'); expect(paths).not.toContain('space%20name.mjs');
  expect(paths).toContain('sub/helper.js'); expect(paths).not.toContain('sub/helper.mjs');
  expect(paths).toContain('sub/package.json');
});

test('does not require type-only modules and rejects a missing native Node ESM .js target', async () => {
  const root = await project(); await writeFile(join(root, 'scenario.ts'), "import type {Missing} from './absent.js';import {type Other} from 'not-installed';export default 42;");
  await expect(captureSourceIdentity(join(root, 'scenario.ts'))).resolves.toMatchObject({ entry: 'scenario.ts' });
  await writeFile(join(root, 'scenario.ts'), "import './helper.js';"); await writeFile(join(root, 'helper.ts'), 'export default 42;');
  await expect(captureSourceIdentity(join(root, 'scenario.ts'))).rejects.toBeInstanceOf(SourceIdentityError);
});

test('honors mid-capture abort and deadline without executing source', async () => {
  const root = await project(); const signal = new AbortController();
  const task = captureSourceIdentity(join(root, 'scenario.mjs'), { signal: signal.signal });
  setImmediate(() => signal.abort());
  await expect(task).rejects.toMatchObject({ kind: 'aborted' });
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'), { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'budget' });
});

test('rejects file changes during capture and closes the opened handle', async () => {
  const root = await project(); const originalOpen = fs.open; let closed = false; let injected = false;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === join(root, 'helper.mjs') && !injected) {
      injected = true; const read = handle.read.bind(handle); const close = handle.close.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        await writeFile(join(root, 'helper.mjs'), 'export const value=123456789;');
        return read(...readArgs);
      }) as typeof handle.read;
      handle.close = async () => { closed = true; return close(); };
    }
    return handle;
  }) as typeof fs.open;
  syncBuiltinESMExports();
  try { await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'changed' }); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  expect(closed).toBe(true);
});

test('captures the actual installed pure-JavaScript pg graph and detects an edited driver with unchanged lock', async () => {
  const root = await project();
  const repository = dirname(new URL('../package.json', import.meta.url).pathname);
  const packages = ['pg', 'pg-connection-string', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass', 'pg-cloudflare', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'pg-int8', 'xtend', 'split2'];
  await mkdir(join(root, 'node_modules'));
  for (const name of packages) await cp(join(repository, 'node_modules', name), join(root, 'node_modules', name), { recursive: true });
  await writeFile(join(root, 'scenario.mjs'), "import {Client} from 'pg';throw new Error('capture must not import this scenario');export default Client;");
  const before = await captureSourceIdentity(join(root, 'scenario.mjs'));
  const pg = before.components.dependencies.packages.find(item => item.name === 'pg')!;
  expect(pg.files.some(file => file.path === 'lib/client.js')).toBe(true);
  expect(pg.dependencies).toContainEqual({ name: 'pg-native', optional: true, missing: true });
  const client = join(root, 'node_modules/pg/lib/client.js');
  await writeFile(client, `${await readFile(client, 'utf8')}\n// locally modified driver\n`);
  const after = await captureSourceIdentity(join(root, 'scenario.mjs'));
  expect(after.components.dependencies.fingerprint).not.toBe(before.components.dependencies.fingerprint);
  expect(after.components.source.fingerprint).toBe(before.components.source.fingerprint);
});

test('rejects native addons in an installed package instead of claiming portable JavaScript identity', async () => {
  const root = await project(); await writeFile(join(root, 'scenario.mjs'), "import 'driver';");
  const driver = await dependency(root, 'driver'); await writeFile(join(driver, 'native.node'), Buffer.from([0, 1, 2]));
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'unsupported' });
});

test('accepts noncanonical system temporary-directory aliases without accepting an in-project symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interleave source alias ')); roots.push(root);
  await writeFile(join(root, 'scenario.mjs'), 'export default 42;');
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).resolves.toMatchObject({ entry: 'scenario.mjs' });
});

test('rejects an explicit root that excludes the controlling package scope', async () => {
  const root = await project(); await mkdir(join(root, 'child')); await writeFile(join(root, 'child/scenario.js'), 'export default 42;');
  await expect(captureSourceIdentity(join(root, 'child/scenario.js'), { projectRoot: join(root, 'child') })).rejects.toMatchObject({ kind: 'unsupported' });
});

test('rejects package self-reference aliases instead of binding an unrelated installed package', async () => {
  const root = await project();
  await json(join(root, 'package.json'), { name: 'identity-fixture', version: '1.0.0', type: 'module', exports: './helper.mjs' });
  await writeFile(join(root, 'scenario.mjs'), "import 'identity-fixture';");
  await dependency(root, 'identity-fixture', '2.0.0');
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'unsupported' });
});

test('rejects a dependency entry point that escapes its package directory', async () => {
  const root = await project(); await writeFile(join(root, 'scenario.mjs'), "import 'driver';");
  const driver = await dependency(root, 'driver'); await writeFile(join(root, 'node_modules/external.js'), 'module.exports=42;');
  await json(join(driver, 'package.json'), { name: 'driver', version: '1.0.0', main: '../external.js' });
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'unsupported' });
});

test('records shared application/runtime package instances without physical paths', async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const root = await realpath(await mkdtemp(join(testDirectory, 'source-sharing-test-'))); roots.push(root);
  await json(join(root, 'package.json'), { name: 'shared-driver-source', version: '1.0.0', type: 'module' });
  await writeFile(join(root, 'scenario.mjs'), "import 'pg';");
  const identity = await captureSourceIdentity(join(root, 'scenario.mjs'));
  expect(identity.sharedPackages.length).toBeGreaterThan(0);
  const applicationPg = identity.components.dependencies.packages.find(pkg => pkg.name === 'pg')!;
  const runtimePg = identity.components.runtime.dependencies.packages.find(pkg => pkg.name === 'pg')!;
  expect(identity.sharedPackages).toContainEqual({ dependencyPackageId: applicationPg.id, runtimePackageId: runtimePg.id });
  expect(JSON.stringify(identity.sharedPackages)).not.toContain(root);
});

test('binds built runtime changes, ignores maps and README noise, and compares clean runtime copies', async () => {
  const root = await temporary(); const runtime = join(root, 'runtime'); const app = join(root, 'app');
  await mkdir(join(runtime, 'dist'), { recursive: true }); await mkdir(app);
  await json(join(runtime, 'package.json'), { name: '@pavangupta352/interleave', version: '1.0.0', type: 'module' });
  await writeFile(join(app, 'scenario.mjs'), 'export default 42;');
  const ts = await import('typescript'); const { build } = await import('esbuild');
  const compiled = ts.transpileModule(await readFile(new URL('../src/source-identity.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText;
  await writeFile(join(runtime, 'dist/source-identity.js'), compiled);
  await build({ entryPoints: [new URL('../src/export-source.ts', import.meta.url).pathname], outfile: join(runtime, 'dist/export-source.js'), bundle: true, platform: 'node', format: 'esm', minify: true,
    banner: { js: "import {createRequire} from 'node:module';import{fileURLToPath}from'node:url';import{dirname}from'node:path';const require=createRequire(import.meta.url);const __filename=fileURLToPath(import.meta.url);const __dirname=dirname(__filename);" } });
  await writeFile(join(runtime, 'dist/runner.js'), 'export const implementation=1;');
  const imported = await import(pathToFileURL(join(runtime, 'dist/source-identity.js')).href) as typeof import('../src/source-identity.js');
  const before = await imported.captureSourceIdentity(join(app, 'scenario.mjs'));
  expect(before.components.runtime.mode).toBe('build');
  await writeFile(join(runtime, 'README.md'), 'Changed documentation'); await writeFile(join(runtime, 'dist/runner.js.map'), '{}');
  expect((await imported.captureSourceIdentity(join(app, 'scenario.mjs'))).fingerprint).toBe(before.fingerprint);
  await writeFile(join(runtime, 'dist/runner.js'), 'export const implementation=2;');
  const changed = await imported.captureSourceIdentity(join(app, 'scenario.mjs'));
  expect(changed.components.runtime.fingerprint).not.toBe(before.components.runtime.fingerprint);
  const copy = await temporary(); await cp(root, copy, { recursive: true });
  const copied = await import(pathToFileURL(join(copy, 'runtime/dist/source-identity.js')).href) as typeof import('../src/source-identity.js');
  expect((await copied.captureSourceIdentity(join(copy, 'app/scenario.mjs'))).fingerprint).toBe(changed.fingerprint);
});

test('binds the actual source-mode TypeScript parser and tsx loader dependency bytes', async () => {
  const root = await temporary(); const runtime = join(root, 'runtime'); const app = join(root, 'app');
  await mkdir(join(runtime, 'src'), { recursive: true }); await mkdir(app);
  await json(join(runtime, 'package.json'), { name: '@pavangupta352/interleave', version: '1.0.0', type: 'module', devDependencies: { typescript: '*', tsx: '*' } });
  await writeFile(join(app, 'scenario.mjs'), 'export default 42;');
  for (const file of ['source-identity.ts', 'export-source.ts']) await cp(new URL(`../src/${file}`, import.meta.url), join(runtime, 'src', file));
  const installed = new URL('../node_modules/', import.meta.url);
  const copied = new Set<string>();
  const copyDependency = async (name: string, optional = false): Promise<void> => {
    if (copied.has(name)) return;
    const source = new URL(`${name}/`, installed);
    const metadataBytes = await readFile(new URL('package.json', source)).catch(error => {
      if (optional && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadataBytes) return;
    copied.add(name);
    await cp(source, join(runtime, 'node_modules', name), { recursive: true });
    const metadata = JSON.parse(metadataBytes.toString());
    for (const child of Object.keys(metadata.dependencies ?? {})) await copyDependency(child);
    for (const child of Object.keys(metadata.optionalDependencies ?? {})) await copyDependency(child, true);
  };
  await copyDependency('typescript'); await copyDependency('tsx');
  const captureProcess = () => spawnSync(process.execPath, [
      '--import', pathToFileURL(join(runtime, 'node_modules/tsx/dist/loader.mjs')).href,
      '--input-type=module', '-e',
      "const {captureSourceIdentity}=await import(process.argv[1]);console.log(JSON.stringify(await captureSourceIdentity(process.argv[2])));",
      pathToFileURL(join(runtime, 'src/source-identity.ts')).href, join(app, 'scenario.mjs'),
    ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
  const capture = (): Awaited<ReturnType<typeof captureSourceIdentity>> => {
    const child = captureProcess();
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout);
  };
  let before = capture();
  expect(before.components.runtime.mode).toBe('source');
  expect(before.components.runtime.dependencies.roots.map(item => item.name)).toEqual(['tsx', 'typescript']);
  expect(before.components.runtime.dependencies.packages.some(item => item.name === 'esbuild')).toBe(true);
  for (const file of ['typescript/lib/typescript.js', 'tsx/dist/loader.mjs', 'esbuild/lib/main.js']) {
    const target = join(runtime, 'node_modules', file);
    await writeFile(target, `${await readFile(target, 'utf8')}\n// identity mutation\n`);
    const after = capture();
    expect(after.components.runtime.fingerprint).not.toBe(before.components.runtime.fingerprint);
    expect(after.components.source.fingerprint).toBe(before.components.source.fingerprint);
    before = after;
  }
  await dependency(join(runtime, 'src/protocol'), 'shadow-driver');
  const rejected = captureProcess();
  expect(rejected.status, rejected.stderr).not.toBe(0);
  expect(rejected.stderr).toMatch(/nested node_modules.*runtime|runtime.*nested node_modules/i);
}, 30_000);

test.each(['colon:name.mjs', 'control\nname.mjs'])('rejects a nonportable entry path %j before emitting an identity', async name => {
  const root = await project(); await writeFile(join(root, name), 'export default 42;');
  await expect(captureSourceIdentity(join(root, name))).rejects.toMatchObject({ kind: 'unsupported' });
});

test.each(['colon:data.json', 'control\ninput.json'])('rejects nonportable explicit data path %j', async name => {
  const root = await project(); await writeFile(join(root, name), '{}');
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'), { include: [name] })).rejects.toMatchObject({ kind: 'unsupported' });
});

test('rejects nonportable files discovered inside a declared dependency package', async () => {
  const root = await project(); await writeFile(join(root, 'scenario.mjs'), "import 'driver';");
  const driver = await dependency(root, 'driver'); await writeFile(join(driver, 'colon:data.json'), '{}');
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'))).rejects.toMatchObject({ kind: 'unsupported' });
});

test('keeps Unicode and dot-prefixed paths while normalizing the whole-root include', async () => {
  const root = await project(); await writeFile(join(root, '.scenario-λ.mjs'), 'export default 42;');
  const identity = await captureSourceIdentity(join(root, '.scenario-λ.mjs'), { include: ['./'] });
  expect(identity.entry).toBe('.scenario-λ.mjs'); expect(identity.includes).toEqual(['.']);
  expect(identity.components.source.files.some(file => file.path === '.scenario-λ.mjs')).toBe(true);
});

test('measures portable include limits in UTF-8 bytes before filesystem lookup', async () => {
  const root = await project();
  await expect(captureSourceIdentity(join(root, 'scenario.mjs'), { include: ['名'.repeat(1400)] })).rejects.toMatchObject({ kind: 'unsupported' });
});

test.each(['driver/\npart', 'driver/\u007fpart', 'driver//part', 'driver/'])('rejects a nonportable raw installed-package specifier %j', async specifier => {
  const root = await project(); await dependency(root, 'driver');
  await writeFile(join(root, 'scenario.mjs'), `import ${JSON.stringify(specifier)};`);
  await expect(captureSourceIdentity(join(root, 'scenario.mjs')).then(() => 'captured')).rejects.toMatchObject({ kind: 'unsupported' });
});

test.each(['name', 'version'])('rejects installed metadata %s beyond the artifact byte limit', async field => {
  const root = await project(); const driver = await dependency(root, 'driver');
  await writeFile(join(root, 'scenario.mjs'), "import 'driver';");
  await json(join(driver, 'package.json'), {
    name: 'driver', version: '1.0.0',
    [field]: field === 'name' ? 'a'.repeat(257) : `1.0.0-${'a'.repeat(251)}`,
  });
  await expect(captureSourceIdentity(join(root, 'scenario.mjs')).then(() => 'captured')).rejects.toMatchObject({ kind: 'unsupported' });
});

test('export capture binds an explicitly selected build without executing it or overriding normal capture', async () => {
  const { captureExportSourceIdentity } = await import('../src/source-identity.js');
  expect(typeof captureExportSourceIdentity).toBe('function');
  const root = await project(); const runtime = join(await temporary(), 'runtime');
  await mkdir(join(runtime, 'dist'), { recursive: true });
  await json(join(runtime, 'package.json'), { name: '@pavangupta352/interleave', version: '1.0.0', type: 'module' });
  await writeFile(join(runtime, 'dist/source-identity.js'), "throw new Error('supplied runtime must not execute');");
  await writeFile(join(runtime, 'dist/runner.js'), 'export const implementation=1;');
  const before = await captureExportSourceIdentity(join(root, 'scenario.mjs'), {}, runtime);
  expect(before.components.runtime.mode).toBe('build');
  expect(before.components.runtime.dependencies.roots).toEqual([]);
  await writeFile(join(runtime, 'dist/runner.js'), 'export const implementation=2;');
  const after = await captureExportSourceIdentity(join(root, 'scenario.mjs'), {}, runtime);
  expect(after.components.runtime.fingerprint).not.toBe(before.components.runtime.fingerprint);
  expect(after.components.source.fingerprint).toBe(before.components.source.fingerprint);
  const normal = await captureSourceIdentity(join(root, 'scenario.mjs'), { runtimeRoot: runtime } as Parameters<typeof captureSourceIdentity>[1]);
  expect(normal.components.runtime.mode).toBe('source');
  const copied = await temporary(); await cp(runtime, copied, { recursive: true });
  expect((await captureExportSourceIdentity(join(root, 'scenario.mjs'), {}, copied)).fingerprint).toBe(after.fingerprint);
  const linkedRoot = join(await temporary(), 'linked-runtime'); await symlink(runtime, linkedRoot);
  await expect(captureExportSourceIdentity(join(root, 'scenario.mjs'), {}, linkedRoot)).rejects.toMatchObject({ kind: 'unsupported' });
  const linkedFile = join(copied, 'dist/source-identity.js');
  await rm(linkedFile); await symlink(join(runtime, 'dist/source-identity.js'), linkedFile);
  await expect(captureExportSourceIdentity(join(root, 'scenario.mjs'), {}, copied)).rejects.toMatchObject({ kind: 'unsupported' });
  await expect(captureExportSourceIdentity(join(root, 'scenario.mjs'), { maxBytes: 10 }, runtime)).rejects.toMatchObject({ kind: 'budget' });
  await expect(captureExportSourceIdentity(join(root, 'scenario.mjs'), { signal: AbortSignal.abort() }, runtime)).rejects.toMatchObject({ kind: 'aborted' });
  await json(join(runtime, 'package.json'), { name: 'unrelated-package', version: '1.0.0' });
  await expect(captureExportSourceIdentity(join(root, 'scenario.mjs'), {}, runtime)).rejects.toMatchObject({ kind: 'unsupported' });
});

test.each(['dist', 'dist/protocol'])('rejects a nested runtime dependency installation in %s that changes actual Node resolution', async directory => {
  const { captureExportSourceIdentity } = await import('../src/source-identity.js');
  const root = await project();
  const runtime = join(await temporary(), 'runtime');
  await mkdir(join(runtime, directory), { recursive: true });
  await json(join(runtime, 'package.json'), { name: '@pavangupta352/interleave', version: '1.0.0', type: 'commonjs', dependencies: { 'shadow-driver': '1.0.0' } });
  await writeFile(join(runtime, 'dist/source-identity.js'), "throw new Error('capture must not execute this runtime');");
  const rootDriver = await dependency(runtime, 'shadow-driver');
  await writeFile(join(rootDriver, 'index.js'), 'module.exports=99;');
  const entry = join(runtime, directory, 'runner.js');
  await writeFile(entry, "console.log(require('shadow-driver'));");
  expect(executeCommonJs(entry)).toBe('99');
  const capture = () => captureExportSourceIdentity(join(root, 'scenario.mjs'), {}, runtime);
  expect((await capture()).components.runtime.dependencies.packages.map(pkg => [pkg.name, pkg.version])).toEqual([['shadow-driver', '1.0.0']]);
  const shadow = await dependency(join(runtime, directory), 'shadow-driver', '2.0.0');
  await writeFile(join(shadow, 'index.js'), 'module.exports=81;');
  expect(executeCommonJs(entry)).toBe('81');
  await expect(capture()).rejects.toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/nested node_modules.*runtime|runtime.*nested node_modules/i) });
});
