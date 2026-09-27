import { defineConfig } from 'prisma/config';

// `prisma generate` and `prisma migrate diff --from-empty` do not connect to a
// database. Commands that do connect read DATABASE_URL from the environment.
export default defineConfig({
  schema: '../prisma/schema.prisma',
  migrations: { path: '../prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
