import { execFile as execute } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
// @ts-expect-error Release tooling is a native Node ESM script.
import { prepareRelease, resolveReleaseSource, verifyPreparedAssets } from '../scripts/prepare-release.mjs';
const execFile = promisify(execute);
const temporary: string[] = [];
const required = ['dist/index.d.ts', 'dist/cli/options.js', 'dist/cli/status.js', 'dist/cli/init.js', 'dist/cli/demo.js', 'dist/cli/doctor.js', 'dist/worker.js', 'dist/report/browser.bundle.js', 'dist/report/styles.css',
  'dist/vendor/typescript/LICENSE.txt', 'dist/vendor/typescript/ThirdPartyNoticeText.txt',
  'dist/examples/neveroversell/scenario.js', 'dist/examples/neveroversell/demo-naive.js', 'dist/examples/neveroversell/demo-safe.js',
  'dist/examples/neveroversell/vendor/LICENSE', 'dist/examples/neveroversell/vendor/SOURCE.json',
  'dist/examples/neveroversell/vendor/sql/001_schema.sql', 'dist/examples/neveroversell/vendor/sql/002_functions.sql',
  'dist/examples/neveroversell/vendor/sql/003_views.sql', 'dist/examples/pghybrid/scenario.js',
  'dist/examples/pghybrid/vendor/LICENSE', 'dist/examples/pghybrid/vendor/SOURCE.json',
  'dist/examples/pghybrid/vendor/pghybrid-0.1.4.tgz', 'dist/examples/pghybrid/vendor/pghybrid/package.json',
  'dist/examples/pghybrid/vendor/pghybrid/LICENSE', 'dist/examples/pghybrid/vendor/pghybrid/dist/index.js'];
async function fixture(variable = false) {
  const root = await mkdtemp(join(tmpdir(), 'interleave release test ')); temporary.push(root);
  const repository = join(root, 'source'); await mkdir(repository);
  const name = '@pavangupta352/interleave'; const version = '0.1.0-dev.0';
  const metadata = { name, version, type: 'module', files: ['dist', 'README.md', 'LICENSE', 'docs', 'examples'],
    exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } }, bin: { interleave: 'dist/cli.js' },
    scripts: { build: 'node build.mjs' } };
  const files: Record<string, string> = { 'package.json': JSON.stringify(metadata), 'package-lock.json': JSON.stringify({ name, version, lockfileVersion: 3, packages: { '': { name, version } } }),
    'README.md': '# Fixture\n', 'LICENSE': 'MIT\n', 'docs/api.md': 'API\n', 'docs/cli.md': 'CLI\n', 'docs/compatibility.md': 'scope\n',
    'examples/postgresjs/scenario.mjs': 'export default {};\n', 'examples/postgresjs/README.md': 'example\n' };
  const cli = `#!/usr/bin/env node\nimport{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';
    const args=process.argv.slice(2);if(args.includes('--version'))console.log('${version}');
    else if(args.includes('--help'))console.log('Interleave help run replay init');
    else if(args[0]==='init'){await mkdir(args[1]);await writeFile(join(args[1],'package.json'),JSON.stringify({dependencies:{'${name}':'${version}'}}));await writeFile(join(args[1],'scenario.mjs'),'export default {};');await writeFile(join(args[1],'README.md'),'fixture');}
    else process.exitCode=2;`;
  files['build.mjs'] = `import{mkdir,writeFile,chmod}from'node:fs/promises';import{dirname}from'node:path';
    for(const path of ${JSON.stringify(required)}){await mkdir(dirname(path),{recursive:true});await writeFile(path,'fixture\\n');}
    await writeFile('dist/index.js','export const defineScenario=x=>x;export const runOnce=()=>{};');
    await writeFile('dist/cli.js',${JSON.stringify(cli)});await chmod('dist/cli.js',0o755);
    ${variable ? "await writeFile('dist/variable.txt',process.cwd().split('/').at(-1));" : ''}`;
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(repository, path)), { recursive: true }); await writeFile(join(repository, path), content); }
  await execFile('git', ['init', '--quiet', repository]);
  await execFile('git', ['-C', repository, 'add', '.']);
  await execFile('git', ['-C', repository, '-c', 'user.name=Pavan Gupta', '-c', 'user.email=pavan.gupta.352@gmail.com', 'commit', '--quiet', '-m', 'Release tool fixture']);
  const ref = (await execFile('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  return { root, repository, ref, version, metadata };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test('builds twice from an immutable committed source and installs the exact original tarball in a path with spaces', async () => {
  const f = await fixture();
  // An untracked local file and a dirty source edit must not leak into the builds.
  await writeFile(join(f.repository, 'README.md'), 'DIRTY CURRENT CHECKOUT');
  await mkdir(join(f.repository, '.local')); await writeFile(join(f.repository, '.local/private-token'), 'PRIVATE');
  const out = join(f.root, 'prepared candidate');
  const manifest = await prepareRelease({ repository: f.repository, ref: f.ref, out });
  expect(manifest.source).toMatchObject({ commit: f.ref, tag: null });
  expect(manifest.status).toBe('prepared-only');
  expect(manifest.reproducibility).toMatchObject({ cleanBuilds: 2, packageBytesEqual: true });
  expect(manifest.acceptance).toMatchObject({ installedArchiveSha256: manifest.package.sha256, import: true, cliVersion: true, cliHelp: true, init: true, database: 'not-run' });
  expect(manifest.qualification).toBeNull();
  const archive = await readFile(join(out, manifest.package.filename));
  expect(createHash('sha256').update(archive).digest('hex')).toBe(manifest.package.sha256);
  expect(await verifyPreparedAssets(out)).toMatchObject({ status: 'prepared-only' });
  const suppliedOut = join(f.root, 'supplied candidate');
  const supplied = await prepareRelease({ repository: f.repository, ref: f.ref, archive: join(out, manifest.package.filename), out: suppliedOut });
  expect(supplied.acceptance.installedArchiveSha256).toBe(manifest.package.sha256);
  expect(await readFile(join(suppliedOut, supplied.package.filename))).toEqual(archive);
  expect((await readFile(join(out, 'consumer-package-lock.json'), 'utf8'))).not.toContain(f.root);
  await writeFile(join(out, 'unexpected-private.txt'), 'private data');
  await expect(verifyPreparedAssets(out)).rejects.toThrow(/unexpected.*asset|inventory/i);
  await rm(join(out, 'unexpected-private.txt'));
  expect(JSON.stringify(manifest)).not.toContain(f.root);
  expect(JSON.stringify(manifest)).not.toContain('PRIVATE');
  const checksums = await readFile(join(out, 'SHA256SUMS'), 'utf8');
  expect(checksums).toContain('release-manifest.json'); expect(checksums).toContain('consumer-package-lock.json');
  await writeFile(join(out, manifest.package.filename), Buffer.concat([archive, Buffer.from('changed')]));
  await expect(verifyPreparedAssets(out)).rejects.toThrow(/checksum|hash|changed/i);
}, 45_000);

test('rejects nonreproducible original pack bytes and creates no completed output', async () => {
  const f = await fixture(true); const out = join(f.root, 'nonreproducible');
  await expect(prepareRelease({ repository: f.repository, ref: f.ref, out })).rejects.toThrow(/differ|reproduc/i);
  await expect(readFile(join(out, 'release-manifest.json'))).rejects.toThrow();
}, 45_000);

test('refuses a different supplied archive and validates it before an expensive build', async () => {
  const f = await fixture(); const archive = join(f.root, 'supplied.tgz'); const out = join(f.root, 'rejected');
  await writeFile(archive, Buffer.from('not a gzip tarball'));
  await expect(prepareRelease({ repository: f.repository, ref: f.ref, archive, out })).rejects.toThrow(/archive/);
  await expect(readFile(join(out, 'release-manifest.json'))).rejects.toThrow();
}, 10_000);

test('requires an existing exact version tag and rejects moving branch input', async () => {
  const f = await fixture();
  await expect(resolveReleaseSource(f.repository, { tag: `v${f.version}` })).rejects.toThrow(/tag|resolve|exist/i);
  await expect(resolveReleaseSource(f.repository, { ref: 'HEAD' })).rejects.toThrow(/commit|immutable/i);
  await expect(resolveReleaseSource(f.repository, { ref: '--help' })).rejects.toThrow(/commit|immutable/i);
  // Local test fixture tag is isolated and never published.
  await execFile('git', ['-C', f.repository, 'tag', `v${f.version}`]);
  expect(await resolveReleaseSource(f.repository, { tag: `v${f.version}` })).toMatchObject({ commit: f.ref, tag: `v${f.version}` });
  await execFile('git', ['-C', f.repository, 'tag', 'v9.9.9']);
  await expect(prepareRelease({ repository: f.repository, tag: 'v9.9.9', out: join(f.root, 'wrong version') })).rejects.toThrow(/tag.*version/i);
}, 10_000);

test('rejects a source module omitted by the build and package, including its maps and declaration', async () => {
  const f = await fixture(); await mkdir(join(f.repository, 'src'));
  await writeFile(join(f.repository, 'src/needed.ts'), 'export const needed = true;\n');
  await execFile('git', ['-C', f.repository, 'add', 'src/needed.ts']);
  await execFile('git', ['-C', f.repository, '-c', 'user.name=Pavan Gupta', '-c', 'user.email=pavan.gupta.352@gmail.com', 'commit', '--quiet', '-m', 'Require compiled module']);
  const ref = (await execFile('git', ['-C', f.repository, 'rev-parse', 'HEAD'])).stdout.trim();
  await expect(prepareRelease({ repository: f.repository, ref, out: join(f.root, 'missing compiled module') })).rejects.toThrow(/compiled.*dist\/needed/);
}, 45_000);


test('rejects a structurally valid supplied archive with changed ordinary bytes instead of replacing it with a good repack', async () => {
  const f = await fixture(); const firstOut = join(f.root, 'original');
  const first = await prepareRelease({ repository: f.repository, ref: f.ref, out: firstOut });
  const tar = gunzipSync(await readFile(join(firstOut, first.package.filename)));
  const at = tar.indexOf(Buffer.from('# Fixture\n')); expect(at).toBeGreaterThan(0);
  Buffer.from('# Changed\n').copy(tar, at);
  const supplied = join(f.root, 'changed.tgz'); await writeFile(supplied, gzipSync(tar));
  await expect(prepareRelease({ repository: f.repository, ref: f.ref, archive: supplied, out: join(f.root, 'changed output') })).rejects.toThrow(/supplied archive differs/i);
  expect(gunzipSync(await readFile(supplied))).toEqual(tar);
}, 45_000);

test('interrupts the owned build process group and removes its temporary source checkout', async () => {
  const f = await fixture(); const marker = join(f.root, 'owned-process.json');
  await writeFile(join(f.repository, 'build.mjs'), `import{spawn}from'node:child_process';
    spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));setInterval(()=>{},1000);`)}],{stdio:['ignore','inherit','inherit']});`);
  await execFile('git', ['-C', f.repository, 'add', 'build.mjs']);
  await execFile('git', ['-C', f.repository, '-c', 'user.name=Pavan Gupta', '-c', 'user.email=pavan.gupta.352@gmail.com', 'commit', '--quiet', '-m', 'Interruptible build fixture']);
  const ref = (await execFile('git', ['-C', f.repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const controller = new AbortController();
  const finished = prepareRelease({ repository: f.repository, ref, out: join(f.root, 'interrupted'), signal: controller.signal })
    .then(() => ({ error: undefined }), (error: Error) => ({ error }));
  let owned: { pid: number; cwd: string } | undefined;
  try {
    const deadline = Date.now() + 8_000;
    while (!owned && Date.now() < deadline) {
      owned = await readFile(marker, 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
      if (!owned) await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    expect(owned).toBeDefined(); controller.abort();
    const result = await finished; expect(result.error?.message).toMatch(/interrupt|abort/i);
    const deadlineForExit = Date.now() + 2_000;
    while (Date.now() < deadlineForExit) {
      try { process.kill(owned!.pid, 0); } catch { break; }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    expect(() => process.kill(owned!.pid, 0)).toThrow();
    await expect(readFile(join(owned!.cwd, 'build.mjs'))).rejects.toThrow();
  } finally { controller.abort(); await finished; }
}, 15_000);
