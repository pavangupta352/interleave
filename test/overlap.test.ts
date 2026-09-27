import { describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { parseCliArgs } from '../src/cli/options.js';
import {
  decisionChoices, decisionsFromTrace, MAX_PLAN_CHOICE_LENGTH, parsePlanChoice, planFromTrace, resolveOverlap, validatePlanEntries,
} from '../src/lanes.js';
import type { RunResult } from '../src/types.js';

const print = (character: string): string => character.repeat(64);
const transport = { version: 1, frontend: 'loopback-plaintext-v1', authentication: 'passthrough-no-channel-binding-v1', upstream: { profile: 'plaintext-v1' } };
function command(index: number, actor: string, sql: string, backendPid: number, available: string[], releasedAt = index, extra: object = {}) {
  return { index, actor, connection: 0, ordinal: 0, protocol: 'simple', sql, fingerprint: print('b'), backendPid, available,
    releasedAt, completedAt: releasedAt + 0.5, completion: { transactionStatus: 'I', commandTags: ['INSERT 0 1'], rowCount: 1 }, waits: [] as unknown[], ...extra };
}
/** alice and bob insert together; carol inserts afterwards. */
function run(): Record<string, any> {
  return {
    schemaVersion: 4, scenario: 'claims', outcome: 'violation', mode: 'explore', plan: ['alice+bob'],
    connections: [
      { actor: 'alice', connection: 0, fingerprint: print('a') }, { actor: 'bob', connection: 0, fingerprint: print('a') },
      { actor: 'carol', connection: 0, fingerprint: print('a') },
    ],
    trace: [
      command(0, 'alice', 'INSERT INTO claim SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM claim)', 101, ['alice', 'bob', 'carol'], 1, { overlap: 0 }),
      command(1, 'bob', 'INSERT INTO claim SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM claim)', 102, ['alice', 'bob', 'carol'], 1, { overlap: 0 }),
      command(2, 'carol', 'SELECT count(*) FROM claim', 103, ['carol'], 3),
    ],
    actors: [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled' }, { actor: 'carol', status: 'fulfilled' }],
    failure: { name: 'AssertionError', message: 'two claims', fingerprint: print('e') },
    environment: { serverVersion: '16.15', nodeVersion: 'v24.7.0', transport },
    startedAt: '2026-09-27T00:00:00.000Z', durationMs: 10,
    limits: { maxSteps: 100, timeoutMs: 10_000, maxEvidenceBytes: 8 * 1024 * 1024, maxConnectionsPerActor: 1,
      protocolProfile: 'sync-cycle-v1', connectionProfile: 'single-producer-v1', overlap: 'pairs' },
    cleanup: { complete: true },
  };
}

describe('pair plan choices', () => {
  test.each([
    ['alice', [{ actor: 'alice' }]],
    ['alice+bob', [{ actor: 'alice' }, { actor: 'bob' }]],
    ['alice#1+bob#0', [{ actor: 'alice', connection: 1 }, { actor: 'bob', connection: 0 }]],
    ['alice+alice#2', [{ actor: 'alice' }, { actor: 'alice', connection: 2 }]],
  ])('parses %s', (value, expected) => { expect(parsePlanChoice(value)).toEqual(expected); });

  test.each(['', '+', 'alice+', '+bob', 'alice++bob', 'alice+bob+carol', 'alice+__proto__', 'alice + bob', 'alice,bob', 7, null])(
    'rejects %j', value => { expect(parsePlanChoice(value)).toBeUndefined(); });

  test('accepts the longest pair of lane labels and nothing longer', () => {
    const lane = `${'a'.repeat(48)}#999999999`;
    expect(`${lane}+${lane}`).toHaveLength(MAX_PLAN_CHOICE_LENGTH);
    expect(parsePlanChoice(`${lane}+${lane}`)).toHaveLength(2);
    expect(parsePlanChoice(`${lane}+${lane}0`)).toBeUndefined();
  });

  test('pairs require overlap and two distinct actors or lanes', () => {
    expect(() => validatePlanEntries(['alice+bob'], 'single-producer-v1')).toThrow(/require overlap pairs/);
    expect(() => validatePlanEntries(['alice+bob', 'carol'], 'single-producer-v1', ['alice', 'bob', 'carol'], 'pairs')).not.toThrow();
    expect(() => validatePlanEntries(['alice+alice'], 'single-producer-v1', undefined, 'pairs')).toThrow(/two different actors/);
    expect(() => validatePlanEntries(['alice+dave'], 'single-producer-v1', ['alice', 'bob'], 'pairs')).toThrow(/unknown actor/);
    expect(() => validatePlanEntries(['alice#0+bob'], 'single-producer-v1', undefined, 'pairs')).toThrow(/require connectionProfile multi-producer-v1/);
    // Two lanes of one multi-producer actor may overlap; one lane cannot pair with itself.
    expect(() => validatePlanEntries(['alice+alice', 'alice#0+alice#1', 'alice#0+alice'], 'multi-producer-v1', undefined, 'pairs')).not.toThrow();
    expect(() => validatePlanEntries(['alice#1+alice#1'], 'multi-producer-v1', undefined, 'pairs')).toThrow(/two different lanes/);
  });

  test('overlap resolves only an omitted option', () => {
    expect(resolveOverlap(undefined)).toBeUndefined();
    expect(resolveOverlap(undefined, 'pairs')).toBe('pairs');
    expect(resolveOverlap('pairs')).toBe('pairs');
    for (const value of [null, '', 'triples', true]) expect(() => resolveOverlap(value, 'pairs')).toThrow('overlap must be pairs');
  });
});

describe('decisions', () => {
  test('a recorded pair is one decision and one plan choice', () => {
    const original = run() as unknown as RunResult;
    expect(decisionsFromTrace(original)).toEqual([
      { step: 0, choice: 'alice+bob', available: ['alice', 'bob', 'carol'] },
      { step: 2, choice: 'carol', available: ['carol'] },
    ]);
    expect(planFromTrace(original)).toEqual(['alice+bob', 'carol']);
  });

  test('alternatives add unordered pairs only with overlap', () => {
    expect(decisionChoices(['alice', 'bob', 'carol'], new Set(), undefined)).toEqual(['alice', 'bob', 'carol']);
    expect(decisionChoices(['alice', 'bob', 'carol'], new Set(), 'pairs'))
      .toEqual(['alice', 'bob', 'carol', 'alice+bob', 'alice+carol', 'bob+carol']);
    expect(decisionChoices(['alice'], new Set(), 'pairs')).toEqual(['alice']);
  });

  test('multi-producer alternatives use the trace notation for each actor', () => {
    const available = ['alice#0', 'alice#1', 'bob#0'];
    expect(decisionChoices(available, new Set(), 'pairs')).toEqual(['alice', 'bob', 'alice+alice', 'alice+bob']);
    expect(decisionChoices(available, new Set(['alice']), 'pairs'))
      .toEqual(['alice#0', 'alice#1', 'bob', 'alice#0+alice#1', 'alice#0+bob', 'alice#1+bob']);
  });
});

describe('version 4 overlap artifacts', () => {
  test('preserve pairs and exact JSON bytes', () => {
    const original = run();
    expect(parseRunArtifact(original)).toBe(original);
    const serialized = JSON.stringify(original);
    expect(JSON.stringify(parseRunArtifact(serialized))).toBe(serialized);
  });

  test('accept a multi-producer pair of two lanes of one actor', () => {
    const original = run();
    Object.assign(original.limits, { connectionProfile: 'multi-producer-v1', maxConnectionsPerActor: 2 });
    original.plan = ['alice#0+alice#1'];
    original.connections = [{ actor: 'alice', connection: 0, fingerprint: print('a') }, { actor: 'alice', connection: 1, fingerprint: print('a') },
      { actor: 'bob', connection: 0, fingerprint: print('a') }, { actor: 'carol', connection: 0, fingerprint: print('a') }];
    const lanes = ['alice#0', 'alice#1', 'bob#0', 'carol#0'];
    original.trace[0].available = lanes;
    Object.assign(original.trace[1], { actor: 'alice', connection: 1, available: lanes });
    original.trace[2].available = ['carol#0'];
    expect(parseRunArtifact(original)).toBe(original);
    expect(planFromTrace(original as unknown as RunResult)).toEqual(['alice#0+alice#1', 'carol']);
  });

  test.each([
    ['a pair named by its second step', (r: any) => { r.trace[0].overlap = 1; r.trace[1].overlap = 1; }, /pair is named by the index of its first step/],
    ['a pair without its second step', (r: any) => { delete r.trace[1].overlap; }, /requires a second step with the same overlap index/],
    ['a lone second step', (r: any) => { delete r.trace[0].overlap; }, /pair is named by the index of its first step/],
    ['a pair of one actor', (r: any) => { r.trace[1].actor = 'alice'; r.trace[1].ordinal = 1; r.trace[1].backendPid = 101; }, /two different actors/],
    ['steps released apart', (r: any) => { r.trace[1].releasedAt = 1.5; r.trace[1].completedAt = 2; }, /paired steps are released together/],
    ['steps from two decisions', (r: any) => { r.trace[1].available = ['bob', 'carol']; }, /share one scheduling decision/],
    ['a three-way plan entry', (r: any) => { r.plan = ['alice+bob+carol']; }, /pair names exactly two entries/],
    ['a plan pair of one actor', (r: any) => { r.plan = ['alice+alice']; }, /two different actors/],
    ['a negative overlap index', (r: any) => { r.trace[0].overlap = -1; }, /overlap: expected a finite number/],
    ['a pair plan in version 3', (r: any) => { r.schemaVersion = 3; delete r.limits.connectionProfile; delete r.limits.overlap; }, /plan\[0\]: invalid actor id/],
    ['paired steps in version 3', (r: any) => { r.schemaVersion = 3; delete r.limits.connectionProfile; delete r.limits.overlap; r.plan = ['alice', 'bob']; },
      /trace\[0\]\.overlap: unknown field/],
    ['single-producer version 4 without overlap', (r: any) => { delete r.limits.overlap; }, /requires overlap pairs; use version 3/],
  ])('reject %s', (_name, mutate, message) => {
    const original = run(); mutate(original);
    expect(() => parseRunArtifact(original)).toThrow(message);
  });
});

describe('CLI overlap option', () => {
  test('run accepts overlap pairs and pair plans', () => {
    const parsed = parseCliArgs(['run', 'scenario.mjs', '--overlap', 'pairs', '--plan', 'alice+bob,carol']);
    expect(parsed.values.overlap).toBe('pairs');
    expect(parsed.plan).toEqual(['alice+bob', 'carol']);
  });

  test.each([
    [['run', 's.mjs', '--overlap', 'triples'], '--overlap must be pairs'],
    [['run', 's.mjs', '--plan', 'alice+bob'], '--plan pairs such as alice+bob require --overlap pairs'],
    [['run', 's.mjs', '--overlap', 'pairs', '--plan', 'alice+bob+carol'], '--plan must be comma-separated actor names'],
    [['replay', 's.mjs', 'run.json', '--overlap', 'pairs'], 'Option --overlap is not supported by replay'],
    [['minimize', 's.mjs', 'run.json', '--overlap', 'pairs'], 'Option --overlap is not supported by minimize'],
  ])('rejects %j', (args, message) => { expect(() => parseCliArgs(args)).toThrow(message); });
});
