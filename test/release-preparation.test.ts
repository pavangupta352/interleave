import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
// @ts-expect-error Release tooling is a native Node ESM script.
import { inspectPackageArchive, validatePackageMetadata, validateSourcePaths } from '../scripts/release-archive.mjs';

const metadata = { name: '@pavangupta352/interleave', version: '0.1.0-dev.0', type: 'module',
  files: ['dist', 'README.md', 'LICENSE', 'docs', 'examples'],
  exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
  bin: { interleave: 'dist/cli.js' } };
const lock = () => ({ name: metadata.name, version: metadata.version, lockfileVersion: 3,
  packages: { '': { name: metadata.name, version: metadata.version } } });
const required = ['README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/cli/options.js', 'dist/cli/status.js', 'dist/cli/init.js', 'dist/cli/demo.js', 'dist/cli/doctor.js', 'dist/worker.js',
  'dist/report/browser.bundle.js', 'dist/report/styles.css', 'dist/vendor/typescript/LICENSE.txt',
  'dist/vendor/typescript/ThirdPartyNoticeText.txt', 'docs/api.md', 'docs/cli.md', 'docs/compatibility.md',
  'dist/examples/neveroversell/scenario.js', 'dist/examples/neveroversell/demo-naive.js', 'dist/examples/neveroversell/demo-safe.js',
  'dist/examples/neveroversell/vendor/LICENSE', 'dist/examples/neveroversell/vendor/SOURCE.json',
  'dist/examples/neveroversell/vendor/sql/001_schema.sql', 'dist/examples/neveroversell/vendor/sql/002_functions.sql',
  'dist/examples/neveroversell/vendor/sql/003_views.sql', 'dist/examples/pghybrid/scenario.js',
  'dist/examples/pghybrid/vendor/LICENSE', 'dist/examples/pghybrid/vendor/SOURCE.json',
  'dist/examples/pghybrid/vendor/pghybrid-0.1.4.tgz', 'dist/examples/pghybrid/vendor/pghybrid/package.json',
  'dist/examples/pghybrid/vendor/pghybrid/LICENSE', 'dist/examples/pghybrid/vendor/pghybrid/dist/index.js',
  'examples/postgresjs/scenario.mjs', 'examples/postgresjs/README.md'];
function files() { return new Map<string, Buffer>([['package.json', Buffer.from(JSON.stringify(metadata))],
  ...required.map(path => [path, Buffer.from(`contents for ${path}\n`)] as [string, Buffer])]); }
function archive(entries: Map<string, Buffer>, type = '0') {
  const blocks: Buffer[] = [];
  for (const [path, bytes] of entries) {
    const block = Buffer.alloc(512); const name = `package/${path}`;
    if (name.length > 100) { const split = name.lastIndexOf('/'); block.write(name.slice(0, split), 345); block.write(name.slice(split + 1)); }
    else block.write(name);
    block.write(path === 'dist/cli.js' ? '0000755\0' : '0000644\0', 100);
    block.write('0000000\0', 108); block.write('0000000\0', 116);
    block.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); block.write('00000000000\0', 136);
    block.fill(32, 148, 156); block.write(type, 156); block.write('ustar\0', 257); block.write('00', 263);
    block.write([...block].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('accepts matching development metadata without inventing a tag or publication channel', () => {
  expect(validatePackageMetadata(metadata, lock())).toMatchObject({ name: metadata.name, version: metadata.version, tag: null });
  expect(validatePackageMetadata(metadata, lock(), `v${metadata.version}`).tag).toBe(`v${metadata.version}`);
});

test.each(['top version', 'root version', 'root name', 'lock format', 'tag'])('rejects inconsistent %s before building', kind => {
  const changed = lock(); let tag = `v${metadata.version}`;
  if (kind === 'top version') changed.version = '0.1.0';
  if (kind === 'root version') changed.packages[''].version = '0.1.0';
  if (kind === 'root name') changed.packages[''].name = 'other';
  if (kind === 'lock format') changed.lockfileVersion = 2;
  if (kind === 'tag') tag = 'v0.1.0';
  expect(() => validatePackageMetadata(metadata, changed, tag)).toThrow(/version|name|lock|tag/i);
});

test.each(['01.2.3', '1.2', '1.2.3-01', '1.2.3/other'])('rejects invalid version %s', version => {
  expect(() => validatePackageMetadata({ ...metadata, version }, lock())).toThrow(/version/);
});

test('inspects the supplied archive bytes and retains ordinary nested package-owned data', () => {
  const entries = files(); entries.set('examples/vendor/test/node_modules/fixture.js', Buffer.from('module.exports=41;'));
  const inspected = inspectPackageArchive(archive(entries), metadata);
  expect(inspected.files.get('examples/vendor/test/node_modules/fixture.js')).toEqual(entries.get('examples/vendor/test/node_modules/fixture.js'));
  expect(inspected.inventory.find((entry: { path: string }) => entry.path === 'LICENSE')).toMatchObject({ bytes: entries.get('LICENSE')!.length });
  expect(inspected.sha256).toMatch(/^[a-f0-9]{64}$/); expect(inspected.integrity).toMatch(/^sha512-/);
});

test.each(required)('rejects a real tarball missing required %s', path => {
  const entries = files(); entries.delete(path);
  expect(() => inspectPackageArchive(archive(entries), metadata)).toThrow(/required|missing/i);
});

test('requires the changelog when committed package metadata selects it', () => {
  const changed = { ...metadata, files: [...metadata.files, 'CHANGELOG.md'] }; const entries = files();
  entries.set('package.json', Buffer.from(JSON.stringify(changed)));
  expect(() => inspectPackageArchive(archive(entries), changed)).toThrow(/CHANGELOG/);
  entries.set('CHANGELOG.md', Buffer.from('# Changelog\n'));
  expect(inspectPackageArchive(archive(entries), changed).files.has('CHANGELOG.md')).toBe(true);
});

test.each(['dist/.local/token', 'examples/.git/config', '.npmrc', 'docs/.env', 'docs/key.pem',
  'docs/trace.interleave.json', 'dist/coverage/result.json', 'node_modules/driver/index.js'])('rejects private or managed path %s', path => {
  const entries = files(); entries.set(path, Buffer.from('private'));
  expect(() => inspectPackageArchive(archive(entries), metadata)).toThrow(/private|unexpected|node_modules|bundled/i);
});

test.each(['postgresql://alice:secret@db.example/database', '/Users/alice/private/workspace',
  '/home/runner/work/private/project', '-----BEGIN PRIVATE KEY-----'])('rejects private byte pattern without exposing it in the error', value => {
  const entries = files(); entries.set('docs/accidental.txt', Buffer.from(value));
  expect(() => inspectPackageArchive(archive(entries), metadata)).toThrow(/private content.*docs\/accidental.txt/i);
  try { inspectPackageArchive(archive(entries), metadata); } catch (error) { expect(String(error)).not.toContain(value); }
});

test('rejects a different package identity, corrupted tar and special entries', () => {
  const entries = files(); entries.set('package.json', Buffer.from(JSON.stringify({ ...metadata, version: '9.9.9' })));
  expect(() => inspectPackageArchive(archive(entries), metadata)).toThrow(/metadata|version|identity/);
  const corrupted = archive(files()); corrupted[20] = corrupted[20]! ^ 255;
  expect(() => inspectPackageArchive(corrupted, metadata)).toThrow(/archive|checksum/);
  expect(() => inspectPackageArchive(archive(files(), '2'), metadata)).toThrow(/links|special/);
});

test('rejects unsafe, special or private source tree entries while allowing workflow files', () => {
  expect(() => validateSourcePaths([{ path: '.github/workflows/ci.yml', mode: '100644' }, { path: 'scripts/build.mjs', mode: '100755' }])).not.toThrow();
  for (const entry of [{ path: '../outside', mode: '100644' }, { path: '.local/log', mode: '100644' },
    { path: 'link', mode: '120000' }, { path: 'submodule', mode: '160000' }, { path: 'node_modules/pg/index.js', mode: '100644' }]) {
    expect(() => validateSourcePaths([entry])).toThrow(/unsafe|private|ordinary|managed/);
  }
});
