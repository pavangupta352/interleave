import { test } from 'vitest';
import { qualifyLanguageExample } from './helpers/process-actor-example.js';

// examples/php/README.md: each actor is a PHP program using PDO's default server-side
// prepared statements through the pdo_pgsql extension.
test('PHP PDO actors oversell, replay exactly, reject changed source and pass when repaired', { timeout: 4_200_000 }, async () => {
  await qualifyLanguageExample({
    folder: 'php',
    env: { INTERLEAVE_PHP: process.env.INTERLEAVE_TEST_PHP! },
    prepare: [],
    unsafe: { scenario: 'php/scenario.mjs', include: 'php/checkout.php', edit: { file: 'php/checkout.php', text: '\n// edited after recording\n' } },
    replayElsewhere: { moved: 'same failure' },
    safe: { scenario: 'php/safe-scenario.mjs', include: 'php/checkout_safe.php', budget: ['--max-runs', '1000', '--max-search-bytes', '134217728', '--total-timeout-ms', '3600000'], schedules: 619, timeoutMs: 3_700_000 },
  });
});
