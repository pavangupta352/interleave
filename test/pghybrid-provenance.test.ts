import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readRuntimeArchive } from '../src/export-archive.js';

test('pghybrid package, compiled source maps and license retain their pinned bytes', async () => {
  const vendor = fileURLToPath(new URL('../examples/pghybrid/vendor/', import.meta.url));
  const source = JSON.parse(await readFile(join(vendor, 'SOURCE.json'), 'utf8'));
  const hash = (bytes: Uint8Array | string, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
  const bytes = await readFile(join(vendor, 'pghybrid-0.1.4.tgz'));
  expect(hash(bytes)).toBe(source.hashes['pghybrid-0.1.4.tgz']);
  expect(hash(bytes, 'sha1')).toBe(source.packed.sha1);
  expect(`sha512-${hash(bytes, 'sha512', 'base64')}`).toBe(source.packed.integrity);
  const entries = readRuntimeArchive(bytes);
  expect(entries.size).toBe(source.packed.entryCount);
  expect([...entries.keys()].sort()).toEqual(Object.keys(source.extractedPackage).sort());
  for (const [path, content] of entries) {
    expect(hash(content), path).toBe(source.extractedPackage[path]);
    expect(await readFile(join(vendor, 'pghybrid', path)), path).toEqual(content);
  }
  expect(await readFile(join(vendor, 'LICENSE'))).toEqual(entries.get('LICENSE'));
  expect(hash(await readFile(join(vendor, '../package-lock.json')))).toBe(source.hashes['../package-lock.json']);
  for (const path of ['dist/index.js.map', 'dist/index.cjs.map']) {
    const map = JSON.parse(entries.get(path)!.toString('utf8'));
    expect(map.sources).toHaveLength(6);
    for (const [index, input] of map.sources.entries()) {
      expect(input).toMatch(/^\.\.\/src\/[a-z]+\.ts$/);
      expect(hash(map.sourcesContent[index]), input).toBe(source.hashes[`js/${input.slice(3)}`]);
    }
  }
});
