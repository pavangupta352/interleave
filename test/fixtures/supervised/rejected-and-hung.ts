import type { Scenario } from '../../../src/types.js';

export default {
  name: 'supervised-rejected-and-hung',
  async setup({ db }) { await db.query('SELECT 1'); },
  actors: {
    async a({ connectionString }) {
      const database = decodeURIComponent(new URL(connectionString).pathname.slice(1));
      throw new Error(`Application rejected before harness interruption in ${database}`);
    },
    async b() { await new Promise(() => {}); },
  },
  async invariant() { throw new Error('The invariant must not run with unfinished actors'); },
} satisfies Scenario;
