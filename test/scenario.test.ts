import { describe, expect, test } from 'vitest';
import { defineScenario } from '../src/scenario.js';
import type { Scenario } from '../src/types.js';

function validScenario(): Scenario {
  return {
    name: 'lost update',
    setup: async () => {},
    actors: {
      reader: async () => ({ balance: 10 }),
      writer: async () => ({ balance: 11 }),
    },
    invariant: async () => {},
  };
}

describe('defineScenario', () => {
  test('returns the supplied scenario and preserves application functions', () => {
    const scenario = validScenario();

    const defined = defineScenario(scenario);

    expect(defined).toBe(scenario);
    expect(defined.setup).toBe(scenario.setup);
    expect(defined.actors.reader).toBe(scenario.actors.reader);
    expect(defined.invariant).toBe(scenario.invariant);
  });

  test.each([
    ['', /name/i],
    ['   ', /name/i],
    ['x'.repeat(257), /name/i],
  ])('rejects an invalid scenario name', (name, message) => {
    expect(() => defineScenario({ ...validScenario(), name })).toThrow(message);
  });

  test('requires between two and eight own actor functions', () => {
    expect(() => defineScenario({ ...validScenario(), actors: { only: async () => {} } })).toThrow(/actors/i);
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`actor${index}`, async () => {}]));
    expect(() => defineScenario({ ...validScenario(), actors: tooMany })).toThrow(/actors/i);

    const inherited = Object.create({ hidden: async () => {} }) as Scenario['actors'];
    inherited.first = async () => {};
    inherited.second = async () => {};
    expect(() => defineScenario({ ...validScenario(), actors: inherited })).toThrow(/prototype/i);
  });

  test.each(['1reader', 'has space', 'actor.name', 'a'.repeat(49), 'constructor', 'prototype'])('rejects unsafe actor id %s', (actor) => {
    expect(() => defineScenario({
      ...validScenario(),
      actors: { reader: async () => {}, [actor]: async () => {} },
    })).toThrow(/actor/i);
  });

  test('requires setup, invariant, and every actor to be functions', () => {
    expect(() => defineScenario({ ...validScenario(), setup: undefined as never })).toThrow(/setup/i);
    expect(() => defineScenario({ ...validScenario(), invariant: 'nope' as never })).toThrow(/invariant/i);
    expect(() => defineScenario({
      ...validScenario(),
      actors: { reader: async () => {}, writer: 42 as never },
    })).toThrow(/writer/i);
  });
});
