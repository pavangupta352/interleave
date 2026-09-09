import { expect, test } from 'vitest';
import { parseCliArgs } from '../src/cli/options.js';

test.each([
  ['--strategy', 'fifo'],
  ['--seed', '0'],
  ['--seed', '4294967295'],
  ['--strategy', 'seeded', '--seed', '42'],
])('accepts explicit exploration selection: %j', (...options) => {
  const parsed = parseCliArgs(['run', 'scenario.mjs', ...options]);
  expect(parsed.command).toBe('run');
  expect(parsed.values).toHaveProperty(options[0]!.slice(2), options[1]);
});

test.each(['-0', '-1', '4294967296', '1.5', '1e2', '0x2a', 'NaN', 'Infinity', '', ' '])('rejects a non-uint32 decimal seed: %j', seed => {
  expect(() => parseCliArgs(['run', 'scenario.mjs', `--seed=${seed}`])).toThrow(/seed.*integer.*0.*4294967295/);
});

test.each([
  [['--strategy', 'random'], /strategy.*fifo.*seeded/],
  [['--strategy', 'seeded'], /seeded.*seed/i],
  [['--strategy', 'fifo', '--seed', '0'], /fifo.*seed/i],
  [['--seed', '1', '--seed', '2'], /once/],
  [['--strategy', 'fifo', '--strategy', 'seeded'], /once/],
] as const)('rejects ambiguous or unsupported search selection: %j', (options, message) => {
  expect(() => parseCliArgs(['run', 'scenario.mjs', ...options])).toThrow(message);
});

test.each(['replay', 'minimize', 'doctor', 'demo', 'report', 'export', 'init'])('rejects search selection on %s', command => {
  for (const options of [['--seed', '0'], ['--strategy', 'fifo']]) {
    expect(() => parseCliArgs([command, ...options])).toThrow(/not supported/);
  }
});
