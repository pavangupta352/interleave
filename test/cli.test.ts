import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { parseCliArgs } from '../src/cli/options.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const temporary: string[] = [];
const env = { ...process.env }; delete env.TEST_DATABASE_URL; delete env.INTERLEAVE_TEST_DATABASE_URL;
function execute(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000 });
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('CLI arguments and scaffolding', () => {
  test.each(['doctor', 'demo', 'run', 'replay', 'minimize'])('%s accepts explicit managed PostgreSQL', command => {
    expect(parseCliArgs([command, '--docker']).values).toMatchObject({ docker: true });
    for (const image of ['postgres:16', 'postgres:17', 'postgres:18', 'pgvector/pgvector:0.8.6-pg17-bookworm']) {
      expect(parseCliArgs([command, '--docker', '--postgres-image', image]).values['postgres-image']).toBe(image);
    }
  });
  test.each(['report', 'export', 'init'])('%s cannot provision PostgreSQL', command => {
    expect(() => parseCliArgs([command, '--docker'])).toThrow(/not supported/);
  });
  test('managed options reject ambiguous servers and unqualified images', () => {
    expect(() => parseCliArgs(['doctor', '--postgres-image', 'postgres:17'])).toThrow(/requires --docker/);
    expect(() => parseCliArgs(['doctor', '--docker', '--postgres-image', 'postgres:latest'])).toThrow(/postgres-image/);
    expect(() => parseCliArgs(['doctor', '--docker', '--database-url', 'postgresql://private/db'])).toThrow(/conflict|cannot.*database-url/);
    expect(() => parseCliArgs(['doctor', '--docker', '--fixture-profile', 'postgresql17-pgvector0.8.6-v1', '--postgres-image', 'postgres:17'])).toThrow(/fixture.*image|image.*fixture/);
  });
  test('export accepts one runtime archive and repeated dependency archives', () => {
    const parsed = parseCliArgs(['export', 'scenario.mjs', 'run.json', '--runtime-archive', '/runtime.tgz', '--dependency-archive', '/a.tgz', '--dependency-archive', '/b.tgz']);
    expect(parsed.values).toMatchObject({ 'runtime-archive': '/runtime.tgz', 'dependency-archive': ['/a.tgz', '/b.tgz'] });
    expect(() => parseCliArgs(['run', 'scenario.mjs', '--runtime-archive', '/runtime.tgz'])).toThrow(/not supported/);
    expect(() => parseCliArgs(['export', '--runtime-archive', '/a.tgz', '--runtime-archive', '/b.tgz'])).toThrow(/once/);
  });
  test.each(['run', 'replay', 'minimize'])('source input selection is available on %s', command => {
    const parsed = parseCliArgs([command, 'scenario.mjs', '--project-root', '/project with spaces', '--include', 'input.json', '--include', 'fixtures']);
    expect(parsed.values['project-root']).toBe('/project with spaces');
    expect(parsed.values.include).toEqual(['input.json', 'fixtures']);
  });
  test('help and version need no database and JSON stays parseable', async () => {
    const help = execute(['--help', '--json']);
    expect(help.status).toBe(0); expect(help.stderr).toBe(''); expect(JSON.parse(help.stdout).help).toContain('replay');
    const version = execute(['--version', '--json']);
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(version.status).toBe(0); expect(JSON.parse(version.stdout)).toEqual({ version: metadata.version });
  });
  test.each([
    ['run', 'scenario.mjs', '--max-runs', '-1'],
    ['run', 'scenario.mjs', '--max-runs', '1.5'],
    ['run', 'scenario.mjs', '--max-runs', '2', '--max-runs', '3'],
    ['replay', 'scenario.mjs', 'run.json', '--max-runs', '2'],
    ['run', 'scenario.mjs', '--plan', 'alice,,bob'],
    ['doctor', '--unknown'], ['doctor', '--force'], ['no-such-command'],
  ])('rejects invalid usage before connecting: %j', (...args) => {
    const result = execute([...args, '--json']); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toBeTypeOf('string');
  });
  test('database commands require an explicit administrator URL', () => {
    const result = execute(['doctor', '--json']); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toContain('TEST_DATABASE_URL');
  });
  test('managed selection rejects inherited URLs before connecting or disclosing them', () => {
    const result = execute(['doctor', '--docker', '--json'], { TEST_DATABASE_URL: 'postgresql://private:secret@unavailable.example/app', PATH: '' });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toMatch(/--docker.*TEST_DATABASE_URL/);
    expect(result.stdout + result.stderr).not.toContain('secret');
  });
  test('managed help and version need neither Docker nor a configured database', () => {
    for (const flag of ['--help', '--version']) {
      const result = execute(['doctor', '--docker', flag, '--json'], { PATH: '' });
      expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout)).toHaveProperty(flag.slice(2));
    }
  });
  test('a missing Docker executable produces one actionable JSON error without a server URL', () => {
    const result = execute(['doctor', '--docker', '--json'], { PATH: '' });
    expect(result.status).toBe(2); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).error.message).toMatch(/Docker CLI was not found/);
    expect(JSON.parse(result.stdout).error.message).toContain('TEST_DATABASE_URL');
  });
  test.skipIf(process.platform === 'win32')('a closed progress pipe is a handled command failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleave docker boundary ')); temporary.push(directory);
    const executable = join(directory, 'docker');
    await writeFile(executable, `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[0]==='info')console.log('28.3.3');\nelse if(args[0]==='create')setTimeout(()=>{process.exitCode=1},100);\nelse if(args[0]==='inspect'){console.error('Error: No such container: '+args.at(-1));process.exitCode=1;}\nelse process.exitCode=2;\n`);
    await chmod(executable, 0o700);
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'doctor', '--docker', '--json'], { env: { ...env, PATH: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.once('data', () => child.stderr.destroy());
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code).toBe(2); expect(JSON.parse(stdout).error).toBeDefined();
  });
  test('missing artifact names cannot impersonate a minimization verification error', () => {
    const result = execute(['replay', 'unused.mjs', 'original failure did not reproduce (incompatible)', '--database-url', 'postgresql://invalid/db', '--json']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toMatch(/ENOENT/);
  });
  test.each(['report', 'export'])('%s requires explicit inputs before creating output', command => {
    const result = execute([command, '--json']); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toMatch(/Usage:/);
  });
  test('init writes a complete project at a path with spaces and preserves existing files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleave cli init ')); temporary.push(directory);
    const target = join(directory, 'new project');
    const result = execute(['init', target, '--json']); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).files.sort()).toEqual(['README.md', 'package.json', 'scenario.mjs']);
    const original = await readFile(join(target, 'scenario.mjs'), 'utf8');
    expect(original).toContain('export default defineScenario'); expect(original).toContain('finally');
    const retry = execute(['init', target, '--json']); expect(retry.status).toBe(2);
    expect(await readFile(join(target, 'scenario.mjs'), 'utf8')).toBe(original);
    const occupied = join(directory, 'occupied');
    await import('node:fs/promises').then(fs => fs.mkdir(occupied));
    await writeFile(join(occupied, 'scenario.mjs'), 'preserve me');
    expect(execute(['init', occupied, '--json']).status).toBe(2);
    expect(await readFile(join(occupied, 'scenario.mjs'), 'utf8')).toBe('preserve me');
    await expect(readFile(join(occupied, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
