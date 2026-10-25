import type { Scenario } from '../../../src/types.js';
// The text resembles a credential; only the kind of failure may reach the parent.
export default {
  name: 'uncaught-exception',
  async setup() {},
  actors: {
    async alice() { setTimeout(() => { throw new Error('postgresql://reader:uncaught-secret@example.invalid/reporting'); }, 0); await new Promise(() => {}); },
    async bob() {},
  },
  async invariant() {},
} satisfies Scenario;
