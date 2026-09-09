import type { FixtureIdentity, FixtureIdentityProfile } from './fixture-identity.js';

export function recordedFixtureProfile(fixture?: FixtureIdentity): FixtureIdentityProfile {
  return fixture?.profile === 'postgresql17-pgvector0.8.6-v1' ? fixture.profile : 'native';
}

export function resolveFixtureProfile(value: unknown, fixture?: FixtureIdentity): FixtureIdentityProfile {
  const selected = value === undefined ? recordedFixtureProfile(fixture) : value;
  if (selected !== 'native' && selected !== 'postgresql17-pgvector0.8.6-v1') {
    throw new TypeError('fixtureProfile must be native or postgresql17-pgvector0.8.6-v1');
  }
  return selected;
}
