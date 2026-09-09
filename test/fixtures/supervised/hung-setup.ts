import type { Scenario } from '../../../src/types.js';
export default {
  name: 'supervised-hung-setup',
  async setup() { for (;;) { /* Deliberately blocks IPC and abort delivery. */ } },
  actors: { async alice() {}, async bob() {} },
  async invariant() {},
} satisfies Scenario;
