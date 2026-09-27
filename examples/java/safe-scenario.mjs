import { fileURLToPath } from 'node:url';
import { defineScenario, processActor } from '@pavangupta352/interleave';
import { driverJar, invariant, java, setup } from './shared.mjs';

const checkout = processActor(java, ['-cp', driverJar, fileURLToPath(new URL('./CheckoutSafe.java', import.meta.url))]);
export default defineScenario({ name: 'java-last-unit-safe', setup, actors: { alice: checkout, bob: checkout }, invariant });
