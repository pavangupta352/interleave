import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { sharedInstallerSource, type SharedInstallerConfig } from '../src/export-install.js';

const temporary: string[] = [];
const fingerprint = 'a'.repeat(64);
const json = (path: string, value: unknown) => fs.writeFile(path, JSON.stringify(value));
const exists = (path: string) => fs.lstat(path).then(() => true, () => false);

async function fixture(identity = fingerprint, identitySideEffect = '') {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'interleave shared installer ')));
  temporary.push(root);
  const bundle = join(root, 'bundle'); const app = join(bundle, 'app');
  const archives = join(bundle, 'archives'); const packageRoot = join(root, 'runtime');
  await fs.mkdir(app, { recursive: true }); await fs.mkdir(archives); await fs.mkdir(join(packageRoot, 'dist'), { recursive: true });
  const scriptMarker = join(root, 'lifecycle-ran'); const scenarioMarker = join(root, 'scenario-ran');
  const hookMarker = join(root, 'child-hook-ran'); const captured = join(root, 'captured.json');
  const markerScript = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(scriptMarker)}, 'ran')`)}`;
  await json(join(packageRoot, 'package.json'), {
    name: '@pavangupta352/interleave', version: '0.1.0-test', type: 'module', files: ['dist'],
    scripts: { install: markerScript },
  });
  await fs.writeFile(join(packageRoot, 'dist/source-identity.js'), `
    import { writeFile } from 'node:fs/promises';
    export async function captureExportSourceIdentity(entry, options, runtimeRoot) {
      await writeFile(${JSON.stringify(captured)}, JSON.stringify({ entry, options, runtimeRoot, env: {
        NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH,
        NODE_ENV: process.env.NODE_ENV, npm_config_omit: process.env.npm_config_omit
      }}));
      ${identitySideEffect}
      return { fingerprint: ${JSON.stringify(identity)} };
    }
  `);
  await fs.writeFile(join(packageRoot, 'dist/index.js'), `throw new Error('Runtime API must not load during installation');`);
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', archives, '--cache', join(root, 'packing-cache')], {
    cwd: packageRoot, encoding: 'utf8', timeout: 30_000,
  });
  expect(packed.status, packed.stderr).toBe(0);
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename;
  const archive = `archives/${filename}`;
  const archiveBytes = await fs.readFile(join(bundle, archive));
  const spec = 'file:../../absent-original-runtime.tgz';
  const packageJson = {
    name: 'installer-fixture', version: '1.0.0', type: 'module',
    devDependencies: { '@pavangupta352/interleave': spec }, scripts: { preinstall: markerScript },
  };
  await json(join(app, 'package.json'), packageJson);
  await json(join(app, 'package-lock.json'), {
    name: 'installer-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: packageJson.name, version: packageJson.version, devDependencies: packageJson.devDependencies, hasInstallScript: true },
      'node_modules/@pavangupta352/interleave': {
        name: '@pavangupta352/interleave', version: '0.1.0-test', resolved: spec,
        integrity: `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`, dev: true, hasInstallScript: true,
      },
    },
  });
  await fs.writeFile(join(app, 'scenario.mjs'), `import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(scenarioMarker)}, 'ran');throw new Error('scenario imported');`);
  await fs.writeFile(join(app, 'seed.sql'), 'select 1;');
  const paths = ['app/package.json', 'app/package-lock.json', 'app/scenario.mjs', 'app/seed.sql', archive];
  const files = await Promise.all(paths.map(async path => {
    const data = await fs.readFile(join(bundle, path));
    return { path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }));
  const config: SharedInstallerConfig = { files, archives: [archive], sourceFingerprint: fingerprint, entry: 'scenario.mjs', includes: ['seed.sql'] };
  await fs.writeFile(join(bundle, 'install.mjs'), sharedInstallerSource(config));
  const execute = (env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(bundle, 'install.mjs')], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 40_000,
  });
  return { root, bundle, app, config, execute, scriptMarker, scenarioMarker, hookMarker, captured };
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))); });

test('clean-installs the locked local archive offline without executing package or scenario code', async () => {
  const f = await fixture();
  const result = f.execute();
  expect(result.status, result.stderr).toBe(0);
  expect(await exists(join(f.app, 'node_modules/@pavangupta352/interleave/dist/source-identity.js'))).toBe(true);
  expect(await exists(f.scriptMarker)).toBe(false);
  expect(await exists(f.scenarioMarker)).toBe(false);
  const captured = JSON.parse(await fs.readFile(f.captured, 'utf8'));
  expect(captured).toMatchObject({ entry: join(f.app, 'scenario.mjs'), options: { projectRoot: f.app, include: ['seed.sql'] }, runtimeRoot: join(f.app, 'node_modules/@pavangupta352/interleave') });
  for (const record of f.config.files) {
    const data = await fs.readFile(join(f.bundle, record.path));
    expect(createHash('sha256').update(data).digest('hex')).toBe(record.sha256);
  }
}, 60_000);

test('isolates npm configuration and suppresses inherited hooks in install and identity children', async () => {
  const f = await fixture();
  const npmrc = join(f.root, 'hostile.npmrc');
  await fs.writeFile(npmrc, 'omit=dev\nignore-scripts=false\ninstall-strategy=nested\nglobal=true\n');
  const hook = join(f.root, 'hook.mjs');
  await fs.writeFile(hook, `import{writeFileSync}from'node:fs';if(!process.argv[1]?.endsWith('install.mjs'))writeFileSync(${JSON.stringify(f.hookMarker)},'ran');`);
  const result = f.execute({
    NODE_OPTIONS: `--import=${JSON.stringify(hook)}`, NODE_PATH: f.root, NODE_ENV: 'production',
    npm_config_omit: 'dev', npm_config_userconfig: npmrc, NPM_CONFIG_GLOBALCONFIG: npmrc,
    NPM_CONFIG_PREFIX: join(f.root, 'hostile-prefix'), npm_config_ignore_scripts: 'false',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(await exists(f.captured)).toBe(true);
  expect(JSON.parse(await fs.readFile(f.captured, 'utf8')).env).toEqual({});
  expect(await exists(f.hookMarker)).toBe(false);
  expect(await exists(f.scriptMarker)).toBe(false);
  expect(await exists(join(f.root, 'hostile-prefix'))).toBe(false);
}, 60_000);

test('rejects the clean installation when its complete captured source fingerprint differs', async () => {
  const f = await fixture('b'.repeat(64));
  const result = f.execute();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(/source identity|fingerprint/i);
  expect(await exists(f.scenarioMarker)).toBe(false);
}, 60_000);

test.each(['changed bytes', 'symlink', 'npmrc', 'shrinkwrap', 'existing installation'])('rejects %s before npm can replace an existing path', async kind => {
  const f = await fixture(); const packagePath = join(f.app, 'package.json');
  if (kind === 'changed bytes') await fs.appendFile(packagePath, '\n');
  if (kind === 'symlink') {
    const external = join(f.root, 'external-package.json');
    await fs.rename(packagePath, external); await fs.symlink(external, packagePath);
  }
  if (kind === 'npmrc') await fs.writeFile(join(f.app, '.npmrc'), 'ignore-scripts=false');
  if (kind === 'shrinkwrap') await fs.copyFile(join(f.app, 'package-lock.json'), join(f.app, 'npm-shrinkwrap.json'));
  if (kind === 'existing installation') {
    await fs.mkdir(join(f.app, 'node_modules')); await fs.writeFile(join(f.app, 'node_modules/preserve'), 'unchanged');
  }
  const result = f.execute();
  expect(result.status, result.stderr).toBe(1);
  expect(await exists(f.captured)).toBe(false);
  if (kind === 'existing installation') expect(await fs.readFile(join(f.app, 'node_modules/preserve'), 'utf8')).toBe('unchanged');
  else expect(await exists(join(f.app, 'node_modules'))).toBe(false);
}, 60_000);

test('preserves the producer’s whole-project include marker', async () => {
  const f = await fixture(); f.config.includes = ['.'];
  await fs.writeFile(join(f.bundle, 'install.mjs'), sharedInstallerSource(f.config));
  const result = f.execute();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(await fs.readFile(f.captured, 'utf8')).options.include).toEqual(['.']);
}, 60_000);

test('rejects a durable file larger than the shared export profile permits', async () => {
  const f = await fixture(); const path = 'app/large.bin'; const data = Buffer.alloc(16 * 1024 * 1024 + 1);
  await fs.writeFile(join(f.bundle, path), data);
  f.config.files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  await fs.writeFile(join(f.bundle, 'install.mjs'), sharedInstallerSource(f.config));
  const result = f.execute();
  expect(result.status, result.stderr).toBe(1);
  expect(await exists(join(f.app, 'node_modules'))).toBe(false);
}, 60_000);

test.each(['../outside', '/absolute', 'app/../outside', 'app\\outside'])('rejects an unsafe durable path %s', async path => {
  const f = await fixture();
  f.config.files[0]!.path = path;
  await fs.writeFile(join(f.bundle, 'install.mjs'), sharedInstallerSource(f.config));
  const result = f.execute();
  expect(result.status, result.stderr).toBe(1);
  expect(await exists(join(f.app, 'node_modules'))).toBe(false);
}, 60_000);

test('isolates cache population from npm configuration in an enclosing project', async () => {
  const f = await fixture();
  await json(join(f.root, 'package.json'), { name: 'enclosing-project', version: '1.0.0' });
  await fs.writeFile(join(f.root, '.npmrc'), 'cache=/not-owned/interleave-cache\nuserconfig=/not-owned/user.npmrc\n');
  const result = f.execute();
  expect(result.status, result.stderr).toBe(0);
  expect(await exists(f.captured)).toBe(true);
}, 60_000);

test('stops an interrupted subprocess group after its initial npm process has exited', async () => {
  const f = await fixture(); const bin = join(f.root, 'bin'); const ready = join(f.root, 'descendant-ready');
  await fs.mkdir(bin);
  await fs.writeFile(join(bin, 'npm'), `#!${process.execPath}\nimport{spawn}from'node:child_process';
    spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`)}],{stdio:['ignore','inherit','inherit']});process.exit(0);
  `, { mode: 0o755 });
  const installer = spawn(process.execPath, [join(f.bundle, 'install.mjs')], {
    env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<number | null>(fulfill => installer.once('close', fulfill));
  let descendant: number | undefined;
  try {
    const until = Date.now() + 5000;
    while (!(await exists(ready)) && Date.now() < until) await new Promise(fulfill => setTimeout(fulfill, 20));
    expect(await exists(ready)).toBe(true);
    descendant = Number(await fs.readFile(ready, 'utf8'));
    await new Promise(fulfill => setTimeout(fulfill, 50));
    installer.kill('SIGTERM');
    const result = await Promise.race([closed, new Promise<string>(fulfill => setTimeout(() => fulfill('not-stopped'), 1000))]);
    expect(result).toBe(1);
  } finally {
    installer.kill('SIGKILL');
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    await closed;
  }
}, 15_000);

test('bounds combined subprocess output and leaves every existing file intact', async () => {
  const f = await fixture(); const bin = join(f.root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(join(bin, 'npm'), `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);`, { mode: 0o755 });
  const result = f.execute({ PATH: bin + ':' + process.env.PATH });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(/output limit/);
  expect(await exists(join(f.app, 'node_modules'))).toBe(false);
  expect(await exists(f.captured)).toBe(false);
}, 60_000);

test('preserves a replaced private cache directory and reports ownership uncertainty', async () => {
  const f = await fixture(); const bin = join(f.root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(join(bin, 'npm'), `#!${process.execPath}\nimport{renameSync,mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';
    const path=process.cwd();renameSync(path,path+'.owned');mkdirSync(path);writeFileSync(join(path,'preserve'),'concurrent content');process.exit(1);
  `, { mode: 0o755 });
  const result = f.execute({ PATH: bin + ':' + process.env.PATH });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(/cache ownership changed; nothing was removed/);
  const directories = (await fs.readdir(f.bundle)).filter(name => name.startsWith('.interleave-install-'));
  expect(directories).toHaveLength(2);
  const replacement = directories.find(name => !name.endsWith('.owned'))!;
  expect(await fs.readFile(join(f.bundle, replacement, 'preserve'), 'utf8')).toBe('concurrent content');
  expect(await exists(join(f.bundle, replacement + '.owned', 'user.npmrc'))).toBe(true);
}, 60_000);

test('preserves the original deadline error if cache creation finishes before its ownership can be recorded', async () => {
  const f = await fixture(); const hook = join(f.root, 'deadline-after-mkdtemp.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.mkdtemp;const now=performance.now.bind(performance);
    fs.mkdtemp=async(...args)=>{const path=await original(...args);if(String(args[0]).includes('.interleave-install-'))performance.now=()=>now()+120001;return path;};
    syncBuiltinESMExports();`);
  const result = f.execute({ NODE_OPTIONS: `--import=${JSON.stringify(hook)}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('120 second total time limit');
  expect(result.stderr).not.toMatch(/TypeError|Cannot read properties/);
  expect(result.stderr).toMatch(/ownership.*not recorded; nothing was removed/);
  expect((await fs.readdir(f.bundle)).filter(name => name.startsWith('.interleave-install-'))).toHaveLength(1);
  expect(await exists(join(f.app, 'node_modules'))).toBe(false);
});

test('rejects original application bytes changed while installed identity is being captured', async () => {
  const f = await fixture(fingerprint, `await writeFile(entry, '// changed while capture was running');`);
  const result = f.execute();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(/unchanged ordinary file|integrity mismatch/);
  expect(await exists(f.scenarioMarker)).toBe(false);
}, 60_000);
