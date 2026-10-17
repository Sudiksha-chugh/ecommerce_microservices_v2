import {beforeAll,afterAll,it,expect} from 'vitest';
import {createScenarioTelemetry} from '../../scripts/resilience-telemetry.mjs';
let telemetry:Awaited<ReturnType<typeof createScenarioTelemetry>>;
beforeAll(async()=>{telemetry=await createScenarioTelemetry();});
afterAll(async()=>{await telemetry.shutdown();});
it('collects actual Phase 17 SDK traces and measured scenario metrics',async()=>{
 const result=await telemetry.record('telemetry-unit-scenario','timeout','network',async l=>{l.activate();l.recovering();l.remove();return 42;});
 expect(result.result).toBe(42);expect(result.telemetry.status).toBe('verified');expect(result.telemetry.traces.some(t=>t.name==='resilience.scenario'&&t.traceId!=='0'.repeat(32))).toBe(true);
 expect(result.telemetry.metrics.some(m=>m.name==='resilience.scenarios'&&m.value===1)).toBe(true);
 expect(result.telemetry.metrics.every(m=>!Object.hasOwn(m.attributes,'scenarioId')&&!Object.hasOwn(m.attributes,'traceId'))).toBe(true);
});
it('marks missing lifecycle evidence unavailable while retaining genuine spans',async()=>{
 const result=await telemetry.record('telemetry-missing-lifecycle','timeout','network',async()=>true);
 expect(result.telemetry.status).toBe('unavailable');expect(result.telemetry.reason).toBe('missing-lifecycle');expect(result.telemetry.activatedAt).toBeNull();expect(result.telemetry.traces.length).toBeGreaterThan(0);
});
it('retains failed scenario telemetry without leaking exception text',async()=>{
 await expect(telemetry.record('telemetry-failed-scenario','timeout','network',async l=>{l.activate();try{throw new Error('secret exception content');}finally{l.recovering();l.remove();}})).rejects.toThrow('secret exception content');
 expect(telemetry.evidence.at(-1)?.status).toBe('failed');expect(JSON.stringify(telemetry.evidence)).not.toContain('secret exception content');
});
it('does not initialize a second SDK over a preexisting telemetry provider',async()=>{
 await expect(createScenarioTelemetry()).rejects.toThrow('TEST_TELEMETRY_ALREADY_INITIALIZED');
});

it('marks SDK shutdown evidence unavailable without inventing exported samples',async()=>{
 await telemetry.shutdown();const result=await telemetry.record('telemetry-after-shutdown','timeout','network',async l=>{l.activate();l.recovering();l.remove();return true;});
 expect(result.telemetry.status).toBe('unavailable');expect(result.telemetry.reason).toBe('sdk-unavailable');expect(result.telemetry.metrics).toEqual([]);expect(result.telemetry.traces).toEqual([]);
});
