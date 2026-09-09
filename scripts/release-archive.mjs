import { createHash } from 'node:crypto';
// Node >=22.18 runs this types-only module natively; no build or dependency install
// is needed to inspect an archive before running the selected trusted source.
import { readRuntimeArchive, safeBundlePath } from '../src/export-archive.ts';

const packageName = '@pavangupta352/interleave';
const roots = new Set(['dist', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs', 'examples']);
const required = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/cli/options.js', 'dist/cli/status.js', 'dist/cli/init.js', 'dist/cli/demo.js', 'dist/cli/doctor.js', 'dist/worker.js',
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
const privatePart = /^(?:\.local|\.git|\.npmrc|\.netrc|\.env(?:\..*)?|\.interleave|coverage|playwright-report|test-results)$/i;
const privateSuffix = /(?:\.(?:pem|key|log|tmp)|\.interleave\.json)$/i;
const privateBytes = /postgres(?:ql)?:\/\/[a-z\d_%][^\s"'<>]*|\/Users\/[^\s"']+|\/home\/runner\/work\/|\/private\/var\/|[a-z]:\\Users\\|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export function validatePackageMetadata(metadata, lock, tag = null) {
  const version = metadata?.version;
  const match = typeof version === 'string' && version.length <= 128 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-z\d-]+(?:\.[a-z\d-]+)*))?(?:\+[a-z\d-]+(?:\.[a-z\d-]+)*)?$/i.exec(version);
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error('Package version must be a valid SemVer');
  if (metadata.name !== packageName) throw new Error('Unexpected release package name');
  if (lock?.lockfileVersion !== 3) throw new Error('Release preparation requires lockfile version 3');
  if (lock.name !== metadata.name || lock.packages?.['']?.name !== metadata.name) throw new Error('Package and lockfile names disagree');
  if (lock.version !== version || lock.packages?.['']?.version !== version) throw new Error('Package and lockfile versions disagree');
  if (tag !== null && tag !== `v${version}`) throw new Error('Release tag must exactly match the package version');
  if (!Array.isArray(metadata.files) || !['dist', 'README.md', 'LICENSE', 'docs', 'examples'].every(path => metadata.files.includes(path))
      || metadata.files.some(path => !roots.has(path)) || new Set(metadata.files).size !== metadata.files.length) throw new Error('Unsupported package files selection');
  if (metadata.type !== 'module' || metadata.bin?.interleave !== 'dist/cli.js'
      || metadata.exports?.['.']?.import !== './dist/index.js' || metadata.exports?.['.']?.types !== './dist/index.d.ts') throw new Error('Unsupported public package entry metadata');
  for (const key of ['bundleDependencies', 'bundledDependencies']) {
    if (metadata[key] !== undefined && metadata[key] !== false && !(Array.isArray(metadata[key]) && metadata[key].length === 0)) throw new Error('Bundled dependencies are outside the release profile');
  }
  return { name: metadata.name, version, tag };
}

function checkPath(path) {
  try { safeBundlePath(path, 'Release file path'); } catch { throw new Error('Release archive has an unsafe path'); }
  if (path.split('/').some(part => privatePart.test(part)) || privateSuffix.test(path)) throw new Error(`Release archive contains a private path: ${path}`);
}

export function inspectPackageArchive(bytes, expectedMetadata) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('Package archive exceeds the 32 MiB compressed limit');
  const files = readRuntimeArchive(bytes);
  let metadata;
  try { metadata = JSON.parse(files.get('package.json')?.toString('utf8')); } catch { throw new Error('Archive package metadata is missing or invalid'); }
  if (JSON.stringify(metadata) !== JSON.stringify(expectedMetadata)) throw new Error('Archive package metadata differs from the selected source identity');
  const expected = [...required, ...(expectedMetadata.files.includes('CHANGELOG.md') ? ['CHANGELOG.md'] : [])];
  for (const path of expected) if (!files.has(path) || files.get(path).length === 0) throw new Error(`Release archive is missing required file: ${path}`);
  for (const [path, data] of files) {
    checkPath(path);
    if (path !== 'package.json' && !expectedMetadata.files.includes(path.split('/')[0])) throw new Error(`Unexpected package file: ${path}`);
    // This catches concrete accidental local credentials/paths, not arbitrary
    // secrets. Public release copy still requires review. Archives stay binary.
    if (!path.endsWith('.tgz') && privateBytes.test(data.toString('utf8'))) throw new Error(`Release archive has private content in ${path}`);
  }
  return { files, sha256: sha256(bytes), integrity: integrity(bytes), inventory: [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, data]) => ({ path, bytes: data.length, sha256: sha256(data) })) };
}

export function validateSourcePaths(entries) {
  if (entries.length > 10_000) throw new Error('Source tree exceeds the file count bound');
  const seen = new Set();
  for (const { path, mode } of entries) {
    checkPath(path);
    if (path.startsWith('node_modules/') || path.startsWith('dist/')) throw new Error('Source tree contains generated or managed files');
    if (!['100644', '100755'].includes(mode)) throw new Error(`Source must contain ordinary Git files: ${path}`);
    if (seen.has(path)) throw new Error('Duplicate source tree path');
    seen.add(path);
  }
}
