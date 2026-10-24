import { test } from 'vitest';
import { qualifyLanguageExample } from './helpers/process-actor-example.js';

// examples/go/README.md: the Go toolchain named by INTERLEAVE_TEST_GO builds both
// programs into go/bin; each actor uses pgx's default cached prepared statements.
test('Go pgx actors oversell, replay exactly, reject changed source and pass when repaired', { timeout: 2_400_000 }, async () => {
  await qualifyLanguageExample({
    folder: 'go',
    env: {},
    prepare: [[process.env.INTERLEAVE_TEST_GO!, 'build', '-C', 'go', '-o', 'bin/', './...']],
    unsafe: { scenario: 'go/scenario.mjs', include: 'go/checkout/main.go', edit: { file: 'go/checkout/main.go', text: '\n// edited after recording\n' } },
    replayElsewhere: { moved: 'same failure' },
    safe: { scenario: 'go/safe-scenario.mjs', include: 'go/checkout-safe/main.go', budget: ['--max-runs', '1000', '--total-timeout-ms', '1800000'], schedules: 295, timeoutMs: 1_900_000 },
  });
});
