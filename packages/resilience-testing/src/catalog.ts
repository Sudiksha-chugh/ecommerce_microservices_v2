import {scenarioSchema} from './model.js';
// Only these concrete infrastructure adapters are implemented by resilience-live.mjs.
// Other accepted fault categories require trusted, cancellation-aware local adapters.
export const dependencyScenarios=(['postgres','rabbitmq','redis','elasticsearch'] as const).map(target=>scenarioSchema.parse({
 id:`${target}-owned-outage`,description:`Pause only the owned ${target} fixture`,target,fault:'unavailable',injectionPoint:'before-request',
 preconditions:['owned','healthy','seeded'],maxDurationMs:20000,faultDurationMs:5000,recovery:'restore-owned-fixture',cleanup:'remove-owned-fixture',
 expectedBehavior:'Dependency request fails within deadline; persisted state survives recovery',
 invariants:[{id:'no-false-success',kind:'immediate',recoveryHorizonMs:0},{id:'eventual-recovery',kind:'eventual',recoveryHorizonMs:20000}],
}));
