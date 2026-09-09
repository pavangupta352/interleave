import type { Scenario } from './types.js';

export function defineScenario(input: Scenario): Scenario {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Scenario must be an object');
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Scenario must be a plain object');
  }

  const descriptors = Object.getOwnPropertyDescriptors(input);
  const name = ownValue(descriptors, 'name', 'Scenario name');
  assertScenarioName(name);

  const setup = ownValue(descriptors, 'setup', 'Scenario setup');
  if (typeof setup !== 'function') {
    throw new TypeError('Scenario setup must be a function');
  }

  const invariant = ownValue(descriptors, 'invariant', 'Scenario invariant');
  if (typeof invariant !== 'function') {
    throw new TypeError('Scenario invariant must be a function');
  }

  const actors = ownValue(descriptors, 'actors', 'Scenario actors');
  if (typeof actors !== 'object' || actors === null || Array.isArray(actors)) {
    throw new TypeError('Scenario actors must be an object');
  }
  const actorPrototype = Object.getPrototypeOf(actors);
  if (actorPrototype !== Object.prototype && actorPrototype !== null) {
    throw new TypeError('Scenario actors must not have a custom prototype');
  }
  if (Object.getOwnPropertySymbols(actors).length !== 0) {
    throw new TypeError('Scenario actors must use string actor ids');
  }

  const actorDescriptors = Object.getOwnPropertyDescriptors(actors);
  const actorIds = Object.keys(actorDescriptors);
  if (actorIds.length < 2 || actorIds.length > 8) {
    throw new TypeError('Scenario actors must contain between 2 and 8 actors');
  }
  for (const actor of actorIds) {
    const descriptor = actorDescriptors[actor]!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Scenario actor ${actor} must be an own enumerable value`);
    }
    if (!isSafeActorId(actor)) {
      throw new TypeError(`Scenario actor id ${JSON.stringify(actor)} is invalid`);
    }
    if (typeof descriptor.value !== 'function') {
      throw new TypeError(`Scenario actor ${actor} must be a function`);
    }
  }

  return input;
}

/** @internal Shared validation for declared and serialized scenario identities. */
export function assertScenarioName(value: unknown, label = 'Scenario name'): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${label} must contain 1 to 256 characters and cannot be blank`);
  }
}

const ACTOR_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/;
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isSafeActorId(value: string): boolean {
  return ACTOR_ID.test(value) && !PROTOTYPE_KEYS.has(value);
}

function ownValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
  label: string,
): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`${label} must be an own enumerable value`);
  }
  return descriptor.value;
}
