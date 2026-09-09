import { appendFile } from 'node:fs/promises';
import postgres from 'postgres';
import { forPostgresJs } from '../../../dist/examples/pghybrid/vendor/pghybrid/dist/index.js';
import { CONFIG, EMBEDDING, QUERY, createPghybridScenario } from '../../../dist/examples/pghybrid/scenario.js';

const original = createPghybridScenario();
export default {
  ...original,
  async setup(context) {
    const journal = process.env.PGHYBRID_OWNED_JOURNAL;
    if (!journal) throw new Error('The contained qualification requires its exact ownership journal');
    await appendFile(journal, new URL(context.connectionString).pathname.slice(1) + '\n');
    await original.setup(context);
  },
  // Hold the driver's real initial pg_type query at the readiness boundary.
  actors: {
    async first({ connectionString, signal }) {
      const sql = postgres(connectionString, { max: 1, ssl: false, connection: { application_name: 'pghybrid-adapter-qualification' } });
      let ending;
      const close = (aborted = false) => ending ??= sql.end({ timeout: aborted ? 0 : 1 });
      const abort = () => { void close(true).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        return await forPostgresJs(sql, CONFIG).search(QUERY, { embedding: EMBEDDING, limit: 3 });
      } finally {
        signal.removeEventListener('abort', abort);
        await close();
      }
    },
    async second() { await new Promise(() => {}); },
  },
};
