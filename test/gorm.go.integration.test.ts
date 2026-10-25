import { test } from 'vitest';
import { qualifyLanguageExample } from './helpers/process-actor-example.js';

// examples/gorm/README.md: the Go toolchain named by INTERLEAVE_TEST_GO builds both
// programs into gorm/bin; each actor uses GORM over its postgres driver (pgx). GORM's
// pings, prepares and per-write transactions make the repaired frontier too large to
// exhaust, so the repair is checked with a bounded seeded search.
test('GORM actors oversell, replay exactly, reject changed source and pass when repaired', { timeout: 2_400_000 }, async () => {
  await qualifyLanguageExample({
    folder: 'gorm',
    env: {},
    prepare: [[process.env.INTERLEAVE_TEST_GO!, 'build', '-C', 'gorm', '-o', 'bin/', './...']],
    unsafe: { scenario: 'gorm/scenario.mjs', include: ['gorm/checkout/main.go', 'gorm/shop/shop.go'], edit: { file: 'gorm/checkout/main.go', text: '\n// edited after recording\n' } },
    replayElsewhere: { moved: 'same failure' },
    safe: { scenario: 'gorm/safe-scenario.mjs', include: ['gorm/checkout-safe/main.go', 'gorm/shop/shop.go'],
      budget: ['--seed', '1', '--max-runs', '200', '--total-timeout-ms', '1800000'], schedules: 200, timeoutMs: 1_900_000, stop: 'max-runs' },
  });
});
