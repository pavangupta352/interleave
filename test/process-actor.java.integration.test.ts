import { test } from 'vitest';
import { qualifyLanguageExample } from './helpers/process-actor-example.js';

// examples/java/README.md: fetch-driver.mjs downloads and verifies the pinned pgjdbc
// jar, and the Java 21 launcher named by INTERLEAVE_TEST_JAVA runs each program from source.
test('Java JDBC actors oversell, replay exactly, reject changed source and pass when repaired', { timeout: 2_400_000 }, async () => {
  await qualifyLanguageExample({
    folder: 'java',
    env: { INTERLEAVE_JAVA: process.env.INTERLEAVE_TEST_JAVA! },
    prepare: [[process.execPath, 'java/fetch-driver.mjs']],
    unsafe: { scenario: 'java/scenario.mjs', include: 'java/Checkout.java', edit: { file: 'java/Checkout.java', text: '\n// edited after recording\n' } },
    replayElsewhere: { moved: 'same failure', changedStartup: { TZ: 'Pacific/Chatham' } },
    safe: { scenario: 'java/safe-scenario.mjs', include: 'java/CheckoutSafe.java', budget: ['--max-runs', '1000', '--total-timeout-ms', '1800000'], schedules: 183, timeoutMs: 1_900_000 },
  });
});
