import {describe,it,expect,vi} from 'vitest';
import {scenarioSchema,fixtureSchema,verifyOwnership,evaluate,reportSchema,runScenario,type Controller,type Scenario} from '../src/index.js';
const runId='a'.repeat(24),fixture={runId,project:`phase22-${runId}`,marker:'ecommerce-phase22',resources:['postgres']} as const;
const resource={id:'b'.repeat(64),kind:'container',target:'postgres',mounts:['tmpfs'],labels:{'io.ecommerce.phase22.owner':'ecommerce-phase22','io.ecommerce.phase22.run':runId,'com.docker.compose.project':fixture.project,'io.ecommerce.phase22.target':'postgres'}};
const scenario:Scenario={id:'postgres-unavailable',description:'Owned database outage',target:'postgres',fault:'unavailable',injectionPoint:'before-request',preconditions:['owned','healthy'],maxDurationMs:1000,faultDurationMs:50,recovery:'restore-owned-fixture',cleanup:'remove-owned-fixture',expectedBehavior:'Bounded failure and recovery',invariants:[{id:'no-false-success',kind:'immediate',recoveryHorizonMs:0}]};
const options={allowlist:[scenario.id],sourceRevision:'c'.repeat(40),sourceDigest:'d'.repeat(64)};
function controller(){return {inspect:vi.fn(async()=>resource),precondition:vi.fn(async()=>true),activate:vi.fn(async()=>{}),observe:vi.fn(async()=>({'no-false-success':{observed:0,limit:0,complete:true,elapsedMs:1}})),recover:vi.fn(async()=>true),cleanup:vi.fn(async()=>true)};}
describe('scenario and capability safety',()=>{
 it('accepts bounded scenarios',()=>expect(scenarioSchema.parse(scenario)).toEqual(scenario));
 it.each([{command:'docker stop all'},{endpoint:'http://production'},{path:'/tmp/else'},{containerId:'arbitrary'},{maxDurationMs:300001},{faultDurationMs:1001},{recovery:'none'},{target:'production'},{invariants:[]}])('rejects unsafe scenario %j',change=>expect(scenarioSchema.safeParse({...scenario,...change}).success).toBe(false));
 it('rejects fixture/project mismatch',()=>expect(fixtureSchema.safeParse({...fixture,project:'phase22-'+ 'b'.repeat(24)}).success).toBe(false));
 it('accepts all ownership evidence',()=>expect(verifyOwnership(fixture,resource)).toEqual(resource));
 it.each(['io.ecommerce.phase22.owner','io.ecommerce.phase22.run','com.docker.compose.project','io.ecommerce.phase22.target'])('rejects missing ownership %s',key=>{const r=structuredClone(resource);delete r.labels[key as keyof typeof r.labels];expect(()=>verifyOwnership(fixture,r)).toThrow();});
 it('rejects development mounts',()=>expect(()=>verifyOwnership(fixture,{...resource,mounts:['bind']})).toThrow());
 it('rejects nonallowlisted target',()=>expect(()=>verifyOwnership({...fixture,resources:['redis']},resource)).toThrow());
 it('rejects arbitrary container name',()=>expect(()=>verifyOwnership(fixture,{...resource,id:'dev-postgres'})).toThrow());
 it('rejects unregistered scenario before any access',async()=>{const c=controller();await expect(runScenario(scenario,fixture,c as Controller,{...options,allowlist:[]})).rejects.toThrow();expect(c.inspect).not.toHaveBeenCalled();});
 it('rejects invalid provenance before any access',async()=>{const c=controller();await expect(runScenario(scenario,fixture,c as Controller,{...options,sourceDigest:'x'})).rejects.toThrow();expect(c.inspect).not.toHaveBeenCalled();});
});
describe('runner lifecycle',()=>{
 it('verifies evidence and recovery and cleanup',async()=>{const c=controller();const r=await runScenario(scenario,fixture,c as Controller,options);expect(r.status).toBe('passed');expect(reportSchema.parse(r)).toEqual(r);expect(c.inspect).toHaveBeenCalledTimes(3);});
 it('cleans after activation failure',async()=>{const c=controller();c.activate.mockRejectedValue(new Error('secret'));const r=await runScenario(scenario,fixture,c as Controller,options);expect(r.status).toBe('failed');expect(c.recover).toHaveBeenCalledOnce();expect(c.cleanup).toHaveBeenCalledOnce();expect(JSON.stringify(r)).not.toContain('secret');});
 it('cleans after failed precondition',async()=>{const c=controller();c.precondition.mockResolvedValue(false);const r=await runScenario(scenario,fixture,c as Controller,options);expect(r.limitations).toContain('precondition-failed');expect(c.activate).not.toHaveBeenCalled();expect(c.cleanup).toHaveBeenCalledOnce();});
 it('cleans even when recovery fails',async()=>{const c=controller();c.recover.mockRejectedValue(new Error());const r=await runScenario(scenario,fixture,c as Controller,options);expect(r.recovery.status).toBe('failed');expect(c.cleanup).toHaveBeenCalledOnce();});
 it('reports cleanup failure',async()=>{const c=controller();c.cleanup.mockResolvedValue(false);expect((await runScenario(scenario,fixture,c as Controller,options)).cleanup.status).toBe('failed');});
 it('fails closed on foreign resource',async()=>{const c=controller();c.inspect.mockResolvedValue({...resource,labels:{...resource.labels,'io.ecommerce.phase22.run':'other'}});const r=await runScenario(scenario,fixture,c as Controller,options);expect(r.status).toBe('failed');expect(c.activate).not.toHaveBeenCalled();expect(c.recover).not.toHaveBeenCalled();expect(c.cleanup).not.toHaveBeenCalled();});
 it('revalidates ownership before recovery and cleanup',async()=>{const c=controller();c.inspect.mockResolvedValueOnce(resource).mockRejectedValue(new Error());await runScenario(scenario,fixture,c as Controller,options);expect(c.recover).not.toHaveBeenCalled();expect(c.cleanup).not.toHaveBeenCalled();});
 it('recovers after deadline with fresh cancellation budget',async()=>{const c=controller();c.observe.mockImplementation(async()=>{await new Promise(r=>setTimeout(r,25));return {} as never;});const r=await runScenario({...scenario,maxDurationMs:10,faultDurationMs:5},fixture,c as Controller,options);expect(r.limitations).toContain('deadline-exceeded');expect(c.cleanup).toHaveBeenCalled();});
 it('recovers after process interruption',async()=>{const c=controller(),abort=new AbortController();c.activate.mockImplementation(async()=>{abort.abort();});const r=await runScenario(scenario,fixture,c as Controller,{...options,signal:abort.signal});expect(r.limitations).toContain('interrupted');expect(c.cleanup).toHaveBeenCalled();});
 it('does not pass missing evidence',async()=>{const c=controller();c.observe.mockResolvedValue({} as never);expect((await runScenario(scenario,fixture,c as Controller,options)).status).toBe('inconclusive');});
});
describe('invariant evidence',()=>{
 const spec=scenario.invariants[0]!;
 it.each([undefined,{}, {observed:0,limit:0,complete:false,elapsedMs:0},{observed:NaN,limit:0,complete:true,elapsedMs:0}])('missing/invalid evidence is inconclusive',input=>expect(evaluate(spec,input).status).toBe('inconclusive'));
 it('fails violations',()=>expect(evaluate(spec,{observed:1,limit:0,complete:true,elapsedMs:0}).status).toBe('failed'));
 it('fails beyond eventual horizon',()=>expect(evaluate({...spec,kind:'eventual',recoveryHorizonMs:10},{observed:0,limit:0,complete:true,elapsedMs:11}).detail).toBe('horizon-exceeded'));
 it('rejects unknown report fields',async()=>{const r=await runScenario(scenario,fixture,controller() as Controller,options);expect(reportSchema.safeParse({...r,secret:'x'}).success).toBe(false);});
});
it('enforces deadline even when an adapter never settles',async()=>{
 const c=controller();c.observe.mockImplementation(()=>new Promise(()=>{}));
 const r=await runScenario({...scenario,maxDurationMs:20,faultDurationMs:20},fixture,c as Controller,options);
 expect(r.status).toBe('failed');expect(c.recover).toHaveBeenCalledOnce();expect(c.cleanup).toHaveBeenCalledOnce();
});
it('rejects weakening a financial invariant threshold',()=>{
 expect(evaluate({id:'no-duplicate-payment',kind:'immediate',recoveryHorizonMs:0},{observed:1,limit:1,complete:true,elapsedMs:0}).status).toBe('inconclusive');
});
it('rejects a forged pass report when lifecycle evidence is missing',async()=>{
 const r=await runScenario(scenario,fixture,controller() as Controller,options);
 expect(reportSchema.safeParse({...r,recovery:{...r.recovery,verified:false}}).success).toBe(false);
});
