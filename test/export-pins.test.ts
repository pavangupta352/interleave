import { expect, test } from 'vitest';
import { runtimeDependencyPins } from '../src/export.js';
import type { SourceIdentity } from '../src/source-identity.js';

function source(packages: Array<{ name: string; version: string }>): Pick<SourceIdentity, 'components'> {
  const dependencies = { fingerprint: 'f', roots: [], packages: packages.map((item, index) => ({ ...item, id: `p${index}`, dependencies: [], files: [], fingerprint: 'f', fileCount: 0, byteCount: 0 })), fileCount: 0, byteCount: 0 };
  return { components: { runtime: { mode: 'build', dependencies, files: [], fingerprint: 'f', fileCount: 0, byteCount: 0 } } } as unknown as Pick<SourceIdentity, 'components'>;
}

test('pins each runtime dependency to its recorded version, sorted by name', () => {
  expect(runtimeDependencyPins(source([{ name: 'pg-protocol', version: '1.16.0' }, { name: 'pg', version: '8.23.0' }])))
    .toEqual({ pg: '8.23.0', 'pg-protocol': '1.16.0' });
  expect(Object.keys(runtimeDependencyPins(source([{ name: 'b', version: '1.0.0' }, { name: 'a', version: '1.0.0' }]))!)).toEqual(['a', 'b']);
});

test('leaves a name installed in several versions unpinned and omits empty pins', () => {
  expect(runtimeDependencyPins(source([{ name: 'x', version: '1.0.0' }, { name: 'x', version: '2.0.0' }, { name: 'y', version: '3.0.0' }])))
    .toEqual({ y: '3.0.0' });
  expect(runtimeDependencyPins(source([]))).toBeUndefined();
});
