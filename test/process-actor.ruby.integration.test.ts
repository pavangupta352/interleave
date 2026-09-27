import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { qualifyLanguageExample } from './helpers/process-actor-example.js';

const ruby = process.env.INTERLEAVE_TEST_RUBY!;

// examples/ruby/README.md: Bundler installs the locked pg gem into ruby/vendor/bundle,
// and each actor is a Ruby program using the pg gem's default exec_params calls.
test('Ruby pg actors oversell, replay exactly, reject changed source and pass when repaired', { timeout: 900_000 }, async () => {
  await qualifyLanguageExample({
    folder: 'ruby',
    env: { INTERLEAVE_RUBY: ruby },
    prepare: [['env', 'BUNDLE_GEMFILE=ruby/Gemfile', join(dirname(ruby), 'bundle'), 'install']],
    unsafe: { scenario: 'ruby/scenario.mjs', include: 'ruby/checkout.rb', edit: { file: 'ruby/checkout.rb', text: '\n# edited after recording\n' } },
    replayElsewhere: { moved: 'startup changed' },
    safe: { scenario: 'ruby/safe-scenario.mjs', include: 'ruby/checkout_safe.rb', budget: ['--total-timeout-ms', '600000'], schedules: 47, timeoutMs: 660_000 },
  });
});
