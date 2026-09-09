import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { initializeProject } from '../src/cli/init.js';

test('a concurrent replacement survives an interrupted init', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'interleave init ownership '));
  const originalOpen = fs.open;
  let replaced = false;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === join(directory, 'package.json')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await fs.rename(join(directory, 'package.json'), join(directory, 'original-created.json'));
        await fs.writeFile(join(directory, 'package.json'), 'concurrent user content');
        await fs.writeFile(join(directory, 'scenario.mjs'), 'concurrent scenario');
        replaced = true;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await expect(initializeProject(directory, '0.1.0-dev.0')).rejects.toThrow(/overwrite|finish/i);
    expect(replaced).toBe(true);
    expect(await fs.readFile(join(directory, 'package.json'), 'utf8')).toBe('concurrent user content');
    expect(await fs.readFile(join(directory, 'scenario.mjs'), 'utf8')).toBe('concurrent scenario');
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await fs.rm(directory, { recursive: true, force: true }); }
});
