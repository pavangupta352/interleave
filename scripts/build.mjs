import { chmod, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repository, 'dist');
const formatHost = { getCanonicalFileName: path => path, getCurrentDirectory: () => repository, getNewLine: () => '\n' };
function compile(files, options) {
  const program = ts.createProgram(files, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(emitted.diagnostics, formatHost));
}
const config = ts.readConfigFile(join(repository, 'tsconfig.build.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.formatDiagnosticsWithColorAndContext([config.error], formatHost));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repository);
if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost));
await rm(dist, { recursive: true, force: true });
compile(parsed.fileNames, parsed.options);
await build({ entryPoints: [join(repository, 'src/export-source.ts')], outfile: join(dist, 'export-source.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, legalComments: 'eof', banner: { js: "import { createRequire as interleaveCreateRequire } from 'node:module'; import { fileURLToPath as interleaveFilePath } from 'node:url'; import { dirname as interleaveDirname } from 'node:path'; const require = interleaveCreateRequire(import.meta.url); const __filename = interleaveFilePath(import.meta.url); const __dirname = interleaveDirname(__filename);" } });
await mkdir(join(dist, 'vendor/typescript'), { recursive: true });
for (const file of ['LICENSE.txt', 'ThirdPartyNoticeText.txt']) await cp(join(repository, 'node_modules/typescript', file), join(dist, 'vendor/typescript', file));
await build({ entryPoints: [join(repository, 'src/report/browser.ts')], outfile: join(dist, 'report/browser.bundle.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, legalComments: 'none' });
await cp(join(repository, 'src/report/styles.css'), join(dist, 'report/styles.css'));
const temporary = await mkdtemp(join(tmpdir(), 'interleave-build-'));
try {
  compile(['scenario.ts', 'demo-naive.ts', 'demo-safe.ts'].map(file => join(repository, 'examples/neveroversell', file)), {
    ...parsed.options, rootDir: repository, outDir: temporary, declaration: false, declarationMap: false, sourceMap: false,
  });
  await mkdir(join(dist, 'examples'), { recursive: true });
  await cp(join(temporary, 'examples/neveroversell'), join(dist, 'examples/neveroversell'), { recursive: true });
  for (const file of ['vendor/sql', 'vendor/LICENSE', 'vendor/SOURCE.json', 'README.md']) {
    await cp(join(repository, 'examples/neveroversell', file), join(dist, 'examples/neveroversell', file), { recursive: true });
  }
  await chmod(join(dist, 'cli.js'), 0o755);
} finally { await rm(temporary, { recursive: true, force: true }); }
const metadata = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
console.log(`Built Interleave ${metadata.version} and the pinned neveroversell runtime.`);
