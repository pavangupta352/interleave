import { describe, expect, test } from 'vitest';
import {
  fairLane, LaneBinder, multiLaneActors, parseLaneLabel, parsePlanEntry, planChoice, planFromTrace, resolveConnectionProfile,
  resolvePlanEntry, validatePlanEntries, type LiveLane, type UnitIdentity,
} from '../src/lanes.js';
import { parseCliArgs } from '../src/cli/options.js';
import type { RunResult, StepIdentity } from '../src/types.js';

const fingerprint = (character: string): string => character.repeat(64);
function unit(sql: string, ordinal = 0, print = fingerprint('a')): UnitIdentity {
  return { ordinal, protocol: 'simple', sql, fingerprint: print };
}
function step(actor: string, connection: number, sql: string, ordinal = 0): StepIdentity {
  return { actor, connection, ...unit(sql, ordinal) };
}
function live(actor: string, connection: number, head?: UnitIdentity, extra: Partial<LiveLane> = {}): LiveLane {
  return { actor, connection, fingerprint: fingerprint('f'), running: false, closed: false, ...(head ? { head } : {}), ...extra };
}
function recording(lanes: Record<string, string[]>, extraConnections: { actor: string; connection: number }[] = []): Pick<RunResult, 'connections' | 'trace'> {
  const connections = [...Object.keys(lanes).map(label => parseLaneLabel(label)!), ...extraConnections]
    .map(lane => ({ ...lane, fingerprint: fingerprint('f') }));
  const trace = Object.entries(lanes).flatMap(([label, commands]) => {
    const lane = parseLaneLabel(label)!;
    return commands.map((sql, ordinal) => step(lane.actor, lane.connection, sql, ordinal));
  });
  return { connections, trace: trace as RunResult['trace'] };
}

describe('plan entries and connection profiles', () => {
  test.each([
    ['alice', { actor: 'alice' }], ['alice#0', { actor: 'alice', connection: 0 }], ['a-b_c#17', { actor: 'a-b_c', connection: 17 }],
    ['z#999999999', { actor: 'z', connection: 999_999_999 }],
  ])('parses %s', (value, expected) => { expect(parsePlanEntry(value)).toEqual(expected); });

  test.each(['', '#1', '1alice', 'alice#', 'alice#01', 'alice#-1', 'alice#1#2', 'alice# 1', 'alice#1234567890', '__proto__',
    'constructor#1', 'prototype', `${'a'.repeat(49)}#1`, 'alice bob'])('rejects %j', value => {
    expect(parsePlanEntry(value)).toBeUndefined();
  });

  test.each([null, 1, {}, ['alice']])('rejects a non-string entry %j', value => { expect(parsePlanEntry(value)).toBeUndefined(); });

  test('a lane label requires a connection generation', () => {
    expect(parseLaneLabel('alice#2')).toEqual({ actor: 'alice', connection: 2 });
    expect(parseLaneLabel('alice')).toBeUndefined();
  });

  test('lane entries require the multi-producer profile and known actors', () => {
    expect(() => validatePlanEntries(['alice#1', 'bob'], 'multi-producer-v1', ['alice', 'bob'])).not.toThrow();
    expect(() => validatePlanEntries(['alice#1'], 'single-producer-v1', ['alice', 'bob'])).toThrow(/require connectionProfile multi-producer-v1/);
    expect(() => validatePlanEntries(['carol#0'], 'multi-producer-v1', ['alice', 'bob'])).toThrow(/unknown actor/);
    expect(() => validatePlanEntries(['alice#x'], 'multi-producer-v1')).toThrow(/invalid actor/);
    expect(() => validatePlanEntries('alice', 'multi-producer-v1')).toThrow(/Invalid initial schedule/);
    expect(() => validatePlanEntries(new Array(100_001).fill('alice'), 'multi-producer-v1')).toThrow(/Invalid initial schedule/);
    expect(() => validatePlanEntries(undefined, 'single-producer-v1')).not.toThrow();
  });

  test('profiles resolve only omitted options', () => {
    expect(resolveConnectionProfile(undefined)).toBe('single-producer-v1');
    expect(resolveConnectionProfile(undefined, 'multi-producer-v1')).toBe('multi-producer-v1');
    expect(resolveConnectionProfile('multi-producer-v1', 'single-producer-v1')).toBe('multi-producer-v1');
    for (const value of [null, 'auto', 'multi-producer-v2', 1]) expect(() => resolveConnectionProfile(value)).toThrow(/connectionProfile/);
  });

  test('the CLI accepts lane plans only with the multi-producer profile', () => {
    const parsed = parseCliArgs(['run', 'scenario.mjs', '--connection-profile', 'multi-producer-v1', '--plan', 'alice#0,bob,alice#1']);
    expect(parsed.plan).toEqual(['alice#0', 'bob', 'alice#1']);
    expect(parsed.values['connection-profile']).toBe('multi-producer-v1');
    expect(() => parseCliArgs(['run', 'scenario.mjs', '--plan', 'alice#0'])).toThrow(/--connection-profile multi-producer-v1/);
    expect(() => parseCliArgs(['run', 'scenario.mjs', '--connection-profile', 'pool'])).toThrow(/--connection-profile must be/);
    expect(() => parseCliArgs(['run', 'scenario.mjs', '--connection-profile', 'multi-producer-v1', '--plan', 'alice#01'])).toThrow(/--plan/);
    for (const command of ['replay', 'minimize', 'doctor', 'demo']) {
      expect(parseCliArgs([command, '--connection-profile', 'multi-producer-v1']).values['connection-profile']).toBe('multi-producer-v1');
    }
    expect(() => parseCliArgs(['report', 'run.json', '--connection-profile', 'multi-producer-v1'])).toThrow(/not supported by report/);
  });
});

describe('plans derived from traces', () => {
  const trace = [step('alice', 0, 'a'), step('bob', 0, 'b'), step('alice', 1, 'c'), step('bob', 0, 'd', 1)] as RunResult['trace'];
  test('qualify lanes only for actors that used several command connections', () => {
    expect(multiLaneActors(trace)).toEqual(new Set(['alice']));
    expect(planFromTrace({ trace, limits: { maxSteps: 1, timeoutMs: 1, connectionProfile: 'multi-producer-v1' } })).toEqual(['alice#0', 'bob', 'alice#1', 'bob']);
    expect(planFromTrace({ trace, limits: { maxSteps: 1, timeoutMs: 1 } })).toEqual(['alice', 'bob', 'alice', 'bob']);
    expect(planChoice('alice#1', new Set(['alice']))).toBe('alice#1');
    expect(planChoice('bob#0', new Set(['alice']))).toBe('bob');
    expect(planChoice('bob', new Set(['alice']))).toBe('bob');
  });
});

describe('lane-aware fair fallback', () => {
  const names = ['alice', 'bob'];
  test('rotates actors first, then each actor rotates among its available lanes', () => {
    const lanes = [{ actor: 'alice', connection: 0 }, { actor: 'alice', connection: 2 }, { actor: 'bob', connection: 1 }];
    expect(fairLane(names, lanes, undefined, new Map())).toEqual({ actor: 'alice', connection: 0 });
    expect(fairLane(names, lanes, 'alice', new Map([['alice', 0]]))).toEqual({ actor: 'bob', connection: 1 });
    expect(fairLane(names, lanes, 'bob', new Map([['alice', 0], ['bob', 1]]))).toEqual({ actor: 'alice', connection: 2 });
    expect(fairLane(names, lanes, 'bob', new Map([['alice', 2]]))).toEqual({ actor: 'alice', connection: 0 });
    expect(fairLane(names, [lanes[2]!], 'bob', new Map([['bob', 1]]))).toEqual({ actor: 'bob', connection: 1 });
    expect(() => fairLane(names, [], undefined, new Map())).toThrow(/available lane/);
  });
});

describe('explicit plan entries at a decision point', () => {
  const available = live('alice', 1, unit('x'));
  test('release available lanes and choose among an actor lanes by rotation', () => {
    expect(resolvePlanEntry({ actor: 'alice', connection: 1 }, [available], false, new Map(), 3)).toEqual({ kind: 'release', lane: available });
    const both = [live('alice', 0, unit('y')), available];
    expect(resolvePlanEntry({ actor: 'alice' }, both, false, new Map([['alice', 0]]), 0)).toMatchObject({ kind: 'release', lane: { connection: 1 } });
    expect(resolvePlanEntry({ actor: 'alice' }, both, false, new Map([['alice', 1]]), 0)).toMatchObject({ kind: 'release', lane: { connection: 0 } });
  });

  test('wait while the named connection may still queue, otherwise the prefix is infeasible', () => {
    expect(resolvePlanEntry({ actor: 'alice', connection: 4 }, [available], false, new Map(), 2)).toEqual({
      kind: 'wait', reason: 'Schedule asks for alice#4 at step 2, which has not queued its next command' });
    expect(resolvePlanEntry({ actor: 'alice', connection: 0 }, [live('alice', 0)], false, new Map(), 2).kind).toBe('wait');
    const incompatible = { kind: 'incompatible', reason: 'Schedule asks for alice#0, which cannot issue its next query at step 2' };
    expect(resolvePlanEntry({ actor: 'alice', connection: 0 }, [live('alice', 0)], true, new Map(), 2)).toEqual(incompatible);
    expect(resolvePlanEntry({ actor: 'alice', connection: 0 }, [live('alice', 0, unit('x'), { running: true })], false, new Map(), 2)).toEqual(incompatible);
    expect(resolvePlanEntry({ actor: 'alice', connection: 0 }, [live('alice', 0, undefined, { closed: true })], false, new Map(), 2)).toEqual(incompatible);
    // Actor choices never wait for idle lanes, as in the single-producer profile.
    expect(resolvePlanEntry({ actor: 'alice' }, [live('alice', 0, unit('x'), { running: true })], false, new Map(), 2)).toEqual({
      kind: 'incompatible', reason: 'Schedule asks for alice, which cannot issue its next query at step 2' });
  });
});

describe('exact replay lane binding', () => {
  test('keeps the recorded generation when its queued head matches', () => {
    const binder = new LaneBinder(recording({ 'alice#0': ['a'], 'alice#1': ['b'] }));
    const lanes = [live('alice', 0, unit('a')), live('alice', 1, unit('b'))];
    expect(binder.resolve(step('alice', 0, 'a'), lanes, false, 0)).toEqual({ kind: 'release', lane: lanes[0] });
  });

  test('binds by command identity when accept order is reversed', () => {
    const binder = new LaneBinder(recording({ 'alice#0': ['a', 'a2'], 'alice#1': ['b'] }));
    const lanes = [live('alice', 0, unit('b')), live('alice', 1, unit('a'))];
    expect(binder.mismatch(lanes)).toBeUndefined();
    expect(binder.resolve(step('alice', 0, 'a'), lanes, false, 0)).toEqual({ kind: 'release', lane: lanes[1] });
    binder.bind('alice', 0, 1);
    expect(binder.recordedFor('alice', 1)).toBe(0);
    expect(binder.liveFor('alice', 0)).toBe(1);
    expect(binder.resolve(step('alice', 1, 'b'), lanes, false, 1)).toEqual({ kind: 'release', lane: lanes[0] });
    binder.bind('alice', 1, 0);
    const next = [live('alice', 0), live('alice', 1, unit('a2', 1))];
    expect(binder.mismatch(next)).toBeUndefined();
    expect(binder.resolve(step('alice', 0, 'a2', 1), next, false, 2)).toEqual({ kind: 'release', lane: next[1] });
    expect(() => binder.bind('alice', 0, 0)).toThrow(/one-to-one/);
  });

  test('waits while a matching connection has not queued and fails once its actor settled', () => {
    const binder = new LaneBinder(recording({ 'alice#0': ['a'], 'alice#1': ['b'] }));
    const lanes = [live('alice', 0, unit('b'))];
    expect(binder.resolve(step('alice', 0, 'a'), lanes, false, 0).kind).toBe('wait');
    expect(binder.resolve(step('alice', 0, 'a'), [live('alice', 0)], true, 0)).toEqual({
      kind: 'incompatible', reason: 'Replay expects alice#0, which cannot issue its next query at step 0' });
  });

  test('waits for the recorded generation only when identical first commands later diverge', () => {
    const diverging = new LaneBinder(recording({ 'alice#0': ['BEGIN', 'x'], 'alice#1': ['BEGIN', 'y'] }));
    const early = [live('alice', 0, unit('BEGIN'))];
    expect(diverging.resolve(step('alice', 1, 'BEGIN'), early, false, 0).kind).toBe('wait');
    const arrived = [live('alice', 0, unit('BEGIN')), live('alice', 1, unit('BEGIN'))];
    expect(diverging.resolve(step('alice', 1, 'BEGIN'), arrived, false, 0)).toEqual({ kind: 'release', lane: arrived[1] });
    const identical = new LaneBinder(recording({ 'alice#0': ['BEGIN', 'x'], 'alice#1': ['BEGIN', 'x'] }));
    expect(identical.resolve(step('alice', 1, 'BEGIN'), early, false, 0)).toEqual({ kind: 'release', lane: early[0] });
  });

  test('a queryless recorded generation never delays a distinct command connection', () => {
    const binder = new LaneBinder(recording({ 'alice#1': ['a'] }, [{ actor: 'alice', connection: 0 }]));
    const lanes = [live('alice', 0, unit('a')), live('alice', 1)];
    expect(binder.resolve(step('alice', 1, 'a'), lanes, false, 0)).toEqual({ kind: 'release', lane: lanes[0] });
  });

  test('a bound connection must continue with its own recorded commands', () => {
    const binder = new LaneBinder(recording({ 'alice#0': ['a', 'b'] }));
    binder.bind('alice', 0, 0);
    expect(binder.resolve(step('alice', 0, 'b', 1), [live('alice', 0, unit('changed', 1))], false, 1)).toEqual({
      kind: 'incompatible', reason: 'Replay query or actor startup identity changed for alice at step 1' });
    expect(binder.resolve(step('alice', 0, 'b', 1), [live('alice', 0, undefined, { running: true })], false, 1).kind).toBe('incompatible');
    expect(binder.resolve(step('alice', 0, 'b', 1), [live('alice', 0, undefined, { closed: true })], false, 1).kind).toBe('incompatible');
    expect(binder.resolve(step('alice', 0, 'b', 1), [live('alice', 0)], false, 1).kind).toBe('wait');
    expect(binder.mismatch([live('alice', 0, unit('changed', 1))])).toMatch(/identity changed for alice connection 0/);
    expect(binder.mismatch([live('alice', 0, unit('c', 2))])).toMatch(/more queries than the replay contains/);
    expect(binder.mismatch([live('alice', 0, unit('b', 1))])).toBeUndefined();
  });

  test('an unbound connection must begin like some unbound recorded connection', () => {
    const binder = new LaneBinder(recording({ 'alice#0': ['a'], 'alice#1': ['b'] }));
    expect(binder.mismatch([live('alice', 3, unit('b'))])).toBeUndefined();
    expect(binder.mismatch([live('alice', 3, unit('z'))])).toMatch(/identity changed for alice connection 3/);
    expect(binder.mismatch([live('alice', 3, unit('b'), { fingerprint: fingerprint('e') })])).toMatch(/identity changed/);
    binder.bind('alice', 1, 0);
    expect(binder.mismatch([live('alice', 0), live('alice', 3, unit('b'))])).toMatch(/identity changed for alice connection 3/);
  });

  test('startup identities are counted, not matched by generation', () => {
    const binder = new LaneBinder(recording({ 'alice#0': ['a'], 'alice#1': ['b'] }));
    expect(binder.startup('alice', 5, [fingerprint('f')], fingerprint('f'))).toBeUndefined();
    expect(binder.startup('alice', 6, [fingerprint('f'), fingerprint('f'), fingerprint('f')], fingerprint('f'))).toMatch(/startup identity changed for alice connection 6/);
    expect(binder.startup('alice', 0, [fingerprint('e')], fingerprint('e'))).toMatch(/startup identity changed/);
    expect(binder.complete([{ actor: 'alice', fingerprint: fingerprint('f') }, { actor: 'alice', fingerprint: fingerprint('f') }])).toBe(true);
    expect(binder.complete([{ actor: 'alice', fingerprint: fingerprint('f') }])).toBe(false);
    expect(binder.complete([{ actor: 'alice', fingerprint: fingerprint('f') }, { actor: 'bob', fingerprint: fingerprint('f') }])).toBe(false);
  });

  test('staged identity includes stage, cycle and prefix', () => {
    const describe = { ...step('alice', 0, 'q'), stage: 'describe' as const, cycle: 0 };
    const binder = new LaneBinder({ connections: [{ actor: 'alice', connection: 0, fingerprint: fingerprint('f') }], trace: [describe] as RunResult['trace'] });
    expect(binder.resolve(describe, [live('alice', 0, { ...unit('q'), stage: 'complete', cycle: 0 })], false, 0).kind).toBe('wait');
    expect(binder.resolve(describe, [live('alice', 0, { ...unit('q'), stage: 'describe', cycle: 0 })], false, 0).kind).toBe('release');
  });
});
