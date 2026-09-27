// Manual-barrier baseline: withhold the result of each actor's first lock-row
// read in Knex's ensureTable until both actors have read the lock table.
export const gate = {
  description: 'Knex lock-row read before the conditional initial insert',
  match: sql => sql === 'select * from "public"."knex_migrations_lock"',
};
