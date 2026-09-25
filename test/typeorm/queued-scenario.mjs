import { appendFile } from 'node:fs/promises';
import { withTypeOrmActor } from './connection.mjs';

// Copied into the isolated exact-pin consumer by the explicit qualification.
export default {
  name: 'typeorm-lifecycle-queued-initialization',
  async setup({ connectionString }) {
    await appendFile(process.env.INTERLEAVE_TYPEORM_NAMES, new URL(connectionString).pathname.slice(1) + '\n');
  },
  actors: {
    alice: context => withTypeOrmActor(context, [], runner => runner.query('SELECT 42 AS marker')),
    async bob({ signal }) {
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  },
  invariant() { throw new Error('An interrupted run must not evaluate this invariant'); },
};
