import { appendFile } from 'node:fs/promises';
import { createPghybridAdapterScenario } from '../../../dist/examples/pghybrid/adapters.js';

const original = createPghybridAdapterScenario('postgresjs');
export default {
  ...original,
  async setup(context) {
    const journal = process.env.PGHYBRID_OWNED_JOURNAL;
    if (!journal) throw new Error('The contained qualification requires its exact ownership journal');
    await appendFile(journal, new URL(context.connectionString).pathname.slice(1) + '\n');
    await original.setup(context);
  },
  // Hold the driver's real initial pg_type query at the readiness boundary.
  actors: { first: original.actors.first, async second() { await new Promise(() => {}); } },
};
