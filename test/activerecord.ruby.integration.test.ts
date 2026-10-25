import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { qualifyLanguageExample } from './helpers/process-actor-example.js';

const ruby = process.env.INTERLEAVE_TEST_RUBY!;

// examples/activerecord/README.md: Bundler installs the locked Active Record and pg gems
// into activerecord/vendor/bundle, and each actor is a Ruby program using Active Record.
// Active Record sends several setup commands per connection, so the repair is checked
// with a bounded seeded search.
test('Active Record actors oversell, replay exactly, reject changed source and pass a seeded search when repaired', { timeout: 900_000 }, async () => {
  await qualifyLanguageExample({
    folder: 'activerecord',
    env: { INTERLEAVE_RUBY: ruby },
    prepare: [['env', 'BUNDLE_GEMFILE=activerecord/Gemfile', join(dirname(ruby), 'bundle'), 'install']],
    unsafe: { scenario: 'activerecord/scenario.mjs', include: ['activerecord/checkout.rb', 'activerecord/shop.rb'], edit: { file: 'activerecord/checkout.rb', text: '\n# edited after recording\n' } },
    replayElsewhere: { moved: 'startup changed' },
    safe: { scenario: 'activerecord/safe-scenario.mjs', include: ['activerecord/checkout_safe.rb', 'activerecord/shop.rb'],
      budget: ['--seed', '1', '--max-runs', '200', '--total-timeout-ms', '600000'], schedules: 200, timeoutMs: 660_000, stop: 'max-runs' },
  });
});
