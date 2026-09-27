// Manual-barrier baseline: withhold the result of each runner's
// migrations-table existence check until both runners have checked, or one
// runner has finished without reaching the check.
export const gate = {
  description: 'node-pg-migrate migrations-table existence check',
  match: sql => sql === "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pgmigrations'",
};
