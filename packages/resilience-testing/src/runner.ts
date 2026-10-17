import { bounded } from './bounded.js';
import { fixtureSchema, scenarioSchema, reportSchema, evaluate, verifyOwnership, type Fixture, type Scenario, type Resource, type Report } from './model.js';
export interface Controller {
 // All methods must honor cancellation, settle before returning, and use bounded I/O.
 // The controller owns capabilities; scenario JSON never supplies commands, IDs or URLs.
 inspect(fixture:Fixture,target:Scenario['target'],signal:AbortSignal):Promise<Resource>;
 precondition(name:Scenario['preconditions'][number],signal:AbortSignal):Promise<boolean>;
 activate(scenario:Scenario,signal:AbortSignal):Promise<void>;
 observe(scenario:Scenario,signal:AbortSignal):Promise<Partial<Record<Scenario['invariants'][number]['id'],unknown>>>;
 recover(signal:AbortSignal):Promise<boolean>;
 cleanup(signal:AbortSignal):Promise<boolean>;
}
export async function runScenario(input:unknown,fixtureInput:unknown,controller:Controller,options:{allowlist:readonly string[];sourceRevision:string;sourceDigest:string;signal?:AbortSignal}):Promise<Report>{
 const scenario=scenarioSchema.parse(input),fixture=fixtureSchema.parse(fixtureInput);
 if(!options.allowlist.includes(scenario.id)||!fixture.resources.includes(scenario.target))throw new Error('SCENARIO_REJECTED');
 // Validate provenance BEFORE capabilities can be exercised.
 if(!/^[a-f0-9]{40}$/.test(options.sourceRevision)||!/^[a-f0-9]{64}$/.test(options.sourceDigest))throw new Error('INVALID_PROVENANCE');
 const began=Date.now(),startedAt=new Date(began).toISOString();const limitations:Report['limitations']=[];
 let evidence:Partial<Record<Scenario['invariants'][number]['id'],unknown>>={},recovery:Report['recovery']={status:'inconclusive',verified:false,durationMs:0},cleanup:Report['cleanup']={status:'inconclusive',verified:false,durationMs:0};
 let owned=false;let faultSignal:AbortSignal|undefined;
 const deadline=AbortSignal.timeout(scenario.maxDurationMs),signal=options.signal?AbortSignal.any([deadline,options.signal]):deadline;
 try{
  signal.throwIfAborted();verifyOwnership(fixture,await bounded(signal,()=>controller.inspect(fixture,scenario.target,signal)));owned=true;
  for(const name of scenario.preconditions){signal.throwIfAborted();if(!await bounded(signal,()=>controller.precondition(name,signal))){limitations.push('precondition-failed');throw new Error('PRECONDITION');}}
  signal.throwIfAborted();
  faultSignal=AbortSignal.any([signal,AbortSignal.timeout(scenario.faultDurationMs)]);
  await bounded(faultSignal,()=>controller.activate(scenario,faultSignal!));
  signal.throwIfAborted();evidence=await bounded(faultSignal,()=>controller.observe(scenario,faultSignal!));signal.throwIfAborted();
 }catch{if(options.signal?.aborted)limitations.push('interrupted');else if(deadline.aborted||faultSignal?.aborted)limitations.push('deadline-exceeded');else if(!limitations.length)limitations.push('execution-failed');}
 finally{
  // Never exercise recovery/cleanup against a resource whose ownership was rejected.
  // Recovery and cleanup each have independent budgets, even after cancellation.
  if(owned){
   let step=Date.now();try{const s=AbortSignal.timeout(30000);verifyOwnership(fixture,await bounded(s,()=>controller.inspect(fixture,scenario.target,s)));const verified=await bounded(s,()=>controller.recover(s));recovery={status:verified?'passed':'failed',verified,durationMs:Date.now()-step};if(!verified)limitations.push('recovery-failed');}catch{recovery={status:'failed',verified:false,durationMs:Date.now()-step};limitations.push('recovery-failed');}
   step=Date.now();try{const s=AbortSignal.timeout(30000);verifyOwnership(fixture,await bounded(s,()=>controller.inspect(fixture,scenario.target,s)));const verified=await bounded(s,()=>controller.cleanup(s));cleanup={status:verified?'passed':'failed',verified,durationMs:Date.now()-step};if(!verified)limitations.push('cleanup-failed');}catch{cleanup={status:'failed',verified:false,durationMs:Date.now()-step};limitations.push('cleanup-failed');}
  }
 }
 const invariants=scenario.invariants.map(spec=>evaluate(spec,evidence[spec.id]));
 const status=limitations.length||invariants.some(i=>i.status==='failed')?'failed':invariants.some(i=>i.status==='inconclusive')?'inconclusive':'passed';
 return reportSchema.parse({schemaVersion:1,scenarioId:scenario.id,sourceRevision:options.sourceRevision,sourceDigest:options.sourceDigest,fixture,status,fault:{type:scenario.fault,target:scenario.target},startedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-began,recovery,cleanup,invariants,limitations});
}
