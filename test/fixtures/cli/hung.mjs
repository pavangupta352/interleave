import { writeFile } from 'node:fs/promises';
export default {
  name: 'cli-hung',
  async setup({ db }) {
    if (process.env.INTERLEAVE_CLI_TEST_MARKER) await writeFile(process.env.INTERLEAVE_CLI_TEST_MARKER, (await db.query('SELECT current_database() AS name')).rows[0].name);
    await new Promise(() => undefined);
  },
  actors: { async alice() {}, async bob() {} }, async invariant() {},
};
