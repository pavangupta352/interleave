import type { Scenario } from '../../../src/types.js';
// The text resembles a credential; only the kind of failure may reach the parent.
export default {
  name: 'unhandled-rejection',
  async setup() {},
  actors: {
    async alice() { void Promise.reject(new Error('postgresql://reader:rejected-secret@example.invalid/reporting')); await new Promise(() => {}); },
    async bob() {},
  },
  async invariant() {},
} satisfies Scenario;
