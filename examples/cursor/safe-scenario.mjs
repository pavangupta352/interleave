import { defineScenario } from '@pavangupta352/interleave';
import { deposit, interestJob, invariant, setup } from './shared.mjs';
import { applyInterestAtomically } from './jobs.mjs';

export default defineScenario({ name: 'cursor-interest-safe', setup, actors: { interest: interestJob(applyInterestAtomically), customer: deposit }, invariant });
