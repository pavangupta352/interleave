import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { readRuntimeArchive } from '../src/export-archive.js';

function archive(path: string, type = '0', data = Buffer.from('module.exports=41;')) {
  const block = Buffer.alloc(512);
  block.write(`package/${path}`); block.write('0000644\0', 100); block.write('0000000\0', 108); block.write('0000000\0', 116);
  block.write(data.length.toString(8).padStart(11, '0') + '\0', 124); block.write('00000000000\0', 136);
  block.fill(32, 148, 156); block.write(type, 156); block.write('ustar\0', 257); block.write('00', 263);
  block.write([...block].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([block, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]));
}

test.each(['test/resolver/symlinked/_/node_modules/foo.js', 'test/shadowed_core/node_modules/util/index.js'])('preserves ordinary package-owned bytes at %s', path => {
  const bytes = Buffer.from('module.exports=41;');
  expect(readRuntimeArchive(archive(path, '0', bytes))).toEqual(new Map([[path, bytes]]));
});

test.each(['node_modules/driver/index.js', 'node_modules/file.js'])('rejects package-root managed or bundled path %s', path => {
  expect(() => readRuntimeArchive(archive(path))).toThrow(/node_modules|bundled/);
});

test.each(['1', '2', '3', '4', '6'])('still rejects nested links and special archive entries of type %s', type => {
  expect(() => readRuntimeArchive(archive('fixtures/node_modules/special', type))).toThrow(/links|special/);
});
