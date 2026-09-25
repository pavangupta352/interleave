import assert from 'node:assert/strict';

// Deliberately separate from the root dependency graph and default test suite.
// An unqualified runtime is an explicit failure, never a skipped test row.
assert.equal(process.version, 'v22.18.0', 'TypeORM lifecycle qualification requires Node22.18.0');
assert(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a dedicated PostgreSQL16 administrator database');
await import('../test/typeorm/lifecycle.mjs');
