import { spawn } from 'node:child_process';
import type { Scenario } from '../../../src/types.js';
let descendant: number | undefined;
export default {
  name: 'supervised-descendant',
  async setup() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    descendant = child.pid;
    child.unref();
  },
  actors: { async alice() { return descendant; }, async bob() {} },
  async invariant() {},
} satisfies Scenario;
