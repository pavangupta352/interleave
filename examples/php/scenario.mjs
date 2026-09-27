import { fileURLToPath } from 'node:url';
import { defineScenario, processActor } from '@pavangupta352/interleave';
import { invariant, php, setup } from './shared.mjs';

const checkout = processActor(php, [fileURLToPath(new URL('./checkout.php', import.meta.url))]);
export default defineScenario({ name: 'php-last-unit', setup, actors: { alice: checkout, bob: checkout }, invariant });
