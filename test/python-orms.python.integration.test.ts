import { test } from 'vitest';
import { qualifyLanguageExample, type LanguageExample } from './helpers/process-actor-example.js';

const python = process.env.INTERLEAVE_TEST_PYTHON!;
const edit = (file: string) => ({ file, text: '\n# edited after recording\n' });
const budget = ['--max-runs', '5000', '--total-timeout-ms', '600000'];
// Python writes bytecode into shop/__pycache__ while it runs, so include the files rather than the directory.
const djangoApp = ['django/shop_settings.py', 'django/shop/__init__.py', 'django/shop/models.py'];

// examples/asyncpg, sqlalchemy and django: each README installs the pinned requirements
// into a virtual environment and names its interpreter in INTERLEAVE_PYTHON. CI installs
// every example's requirements into the interpreter named by INTERLEAVE_TEST_PYTHON.
const examples: [string, Omit<LanguageExample, 'env' | 'prepare'>][] = [
  ['asyncpg', {
    folder: 'asyncpg',
    unsafe: { scenario: 'asyncpg/scenario.mjs', include: 'asyncpg/checkout.py', edit: edit('asyncpg/checkout.py') },
    replayElsewhere: { moved: 'same failure' },
    safe: { scenario: 'asyncpg/safe-scenario.mjs', include: 'asyncpg/checkout_safe.py', budget, schedules: 295, timeoutMs: 660_000 },
    runOptions: ['--protocol-profile', 'flush-stages-v1'],
  }],
  ['SQLAlchemy', {
    folder: 'sqlalchemy',
    unsafe: { scenario: 'sqlalchemy/scenario.mjs', include: ['sqlalchemy/checkout.py', 'sqlalchemy/models.py'], edit: edit('sqlalchemy/checkout.py') },
    replayElsewhere: { moved: 'same failure' },
    // SQLAlchemy sends nine setup commands per connection, so the repair is checked by a bounded seeded search.
    safe: { scenario: 'sqlalchemy/safe-scenario.mjs', include: ['sqlalchemy/checkout_safe.py', 'sqlalchemy/models.py'], budget: ['--seed', '1', '--max-runs', '200', '--total-timeout-ms', '600000'], schedules: 200, timeoutMs: 660_000, stop: 'max-runs' },
  }],
  ['Django', {
    folder: 'django',
    unsafe: { scenario: 'django/scenario.mjs', include: ['django/checkout.py', ...djangoApp], edit: edit('django/checkout.py') },
    replayElsewhere: { moved: 'same failure' },
    safe: { scenario: 'django/safe-scenario.mjs', include: ['django/checkout_safe.py', ...djangoApp], budget, schedules: 295, timeoutMs: 660_000 },
  }],
];

test.each(examples)('%s actors oversell, replay exactly, reject changed source and pass when repaired', { timeout: 900_000 }, async (_name, example) => {
  await qualifyLanguageExample({ ...example, env: { INTERLEAVE_PYTHON: python }, prepare: [] });
});
