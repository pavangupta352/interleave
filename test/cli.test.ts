import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const temporary: string[] = [];
const env = { ...process.env }; delete env.TEST_DATABASE_URL; delete env.INTERLEAVE_TEST_DATABASE_URL;
function execute(args: string[]) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], { env, encoding: 'utf8' });
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('CLI arguments and scaffolding', () => {
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
