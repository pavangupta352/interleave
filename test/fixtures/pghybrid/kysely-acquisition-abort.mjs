import { appendFileSync } from 'node:fs';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { observePoolClients } from '../../../dist/examples/pghybrid/adapters.js';
import { forKysely } from '../../../dist/examples/pghybrid/vendor/pghybrid/dist/index.js';
import { CONFIG, EMBEDDING, QUERY, createPghybridScenario } from '../../../dist/examples/pghybrid/scenario.js';

const log = value => appendFileSync(process.env.PGHYBRID_KYSELY_JOURNAL, JSON.stringify(value) + '\n');
const original = createPghybridScenario();
export default {
  ...original,
  name: 'pghybrid-public-kysely-acquisition-cancellation',
  async setup(context) {
    log({ event: 'setup', database: new URL(context.connectionString).pathname.slice(1) });
    await original.setup(context);
  },
  actors: {
    async first({ connectionString, signal }) {
      const pool = new Pool({ connectionString, max: 1 });
      const lifecycle = observePoolClients(pool, () => abort());
      let resolveEnd;
      const endObserved = new Promise(resolve => { resolveEnd = resolve; });
      pool.on('connect', client => {
        log({ event: 'pool-connect' });
        client.once('end', () => { log({ event: 'client-end' }); resolveEnd(); });
      });
      pool.on('acquire', () => log({ event: 'pool-acquire' }));
      const db = new Kysely({ dialect: new PostgresDialect({ pool,
        async onReserveConnection() {
          log({ event: 'reserve-hook-entered' });
          // Actual public acquisition is pending, before the original search's
          // client.query. Return normally after the real terminal event so the
          // driver can release its acquired connection through its usual path.
          await endObserved;
          log({ event: 'reserve-hook-completed' });
        },
      }) });
      let ending;
      const close = () => ending ??= (async () => { await db.destroy(); await lifecycle.waitForEnd(); })();
      const abort = () => { log({ event: 'caller-abort' }); lifecycle.interrupt(); };
      pool.on('error', abort); signal.addEventListener('abort', abort, { once: true });
      try {
        return await forKysely(db, CONFIG).search(QUERY, { embedding: EMBEDDING, limit: 3 });
      } finally {
        signal.removeEventListener('abort', abort);
        try { await close(); log({ event: 'caller-closed' }); } finally { pool.off('error', abort); }
      }
    },
    async second({ signal }) {
      // Withhold readiness during acquisition, then cooperate with cancellation.
      if (signal.aborted) return;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  },
};
