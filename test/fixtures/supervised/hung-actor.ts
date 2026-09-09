import type { Scenario } from '../../../src/types.js';
export default {
  name: 'supervised-hung-actor', async setup() {},
  actors: { async alice() { await new Promise(() => undefined); }, async bob() {} },
  async invariant() {},
} satisfies Scenario;
