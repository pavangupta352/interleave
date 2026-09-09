/** Integration tests never choose an implicit existing PostgreSQL server. */
export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? process.env.INTERLEAVE_TEST_DATABASE_URL;
  if (!value?.trim()) {
    throw new Error('Integration tests require TEST_DATABASE_URL for a dedicated PostgreSQL administrator database. Run npm test or npm run test:integration to provision disposable Docker PostgreSQL automatically.');
  }
  return value;
}
