import {z} from 'zod';
import {bounded} from './bounded.js';
import {verifyOwnership,type Fixture,type Resource} from './model.js';
export const adapterConfigSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('dependency'),target:z.enum(['postgres','rabbitmq','redis','elasticsearch']),durationMs:z.number().int().min(1).max(10000)}),
 z.strictObject({kind:z.literal('process'),target:z.enum(['orders','payments','inventory','consumer','outbox']),operation:z.enum(['terminate','restart','interrupt']),durationMs:z.number().int().min(1).max(10000)}),
 z.strictObject({kind:z.literal('network'),target:z.literal('network'),operation:z.enum(['timeout','connection_reset']),durationMs:z.number().int().min(1).max(10000)}),
 z.strictObject({kind:z.literal('delivery'),target:z.literal('consumer'),operation:z.enum(['duplicate','delivery_delay','restart']),copies:z.number().int().min(1).max(8),delayMs:z.number().int().min(0).max(1000),durationMs:z.number().int().min(1).max(10000)}),
]);
export type AdapterConfig=z.infer<typeof adapterConfigSchema>;
export interface OwnedCapability {
 readonly target:AdapterConfig['target'];
 inspect(signal:AbortSignal):Promise<Resource>;
 activate(config:AdapterConfig,signal:AbortSignal):Promise<void>;
 recover(signal:AbortSignal):Promise<void>;
 cleanup(signal:AbortSignal):Promise<boolean>;
}
export interface AdapterEvidence {config:AdapterConfig;activatedAt:string|null;removedAt:string|null;recovered:boolean;cleaned:boolean}
// Capabilities are registered by fixture construction, never deserialized from a scenario.
// They hold exact process/server/channel handles; the configuration has no commands or IDs.
export class OwnedFaultAdapter {
 readonly config:AdapterConfig;readonly evidence:AdapterEvidence;
 private timer:ReturnType<typeof setTimeout>|undefined;private restoring:Promise<void>|undefined;
 constructor(input:unknown,private readonly fixture:Fixture,private readonly capability:OwnedCapability){
  this.config=adapterConfigSchema.parse(input);
  if(this.config.target!==capability.target||!fixture.resources.includes(this.config.target))throw new Error('ADAPTER_TARGET_REJECTED');
  this.evidence={config:this.config,activatedAt:null,removedAt:null,recovered:false,cleaned:false};
 }
 private async owned(signal:AbortSignal){const r=await bounded(signal,()=>this.capability.inspect(signal));verifyOwnership(this.fixture,r);if(r.target!==this.config.target)throw new Error('ADAPTER_TARGET_REJECTED');}
 async activate(signal:AbortSignal){
  if(this.evidence.activatedAt)throw new Error('ADAPTER_ALREADY_ACTIVE');
  await this.owned(signal);
  // Set the watchdog before activation: cancellation during a partially applied fault
  // still requests restoration. Capabilities must settle before cancellation returns.
  this.timer=setTimeout(()=>{void this.recover(AbortSignal.timeout(10000)).catch(()=>{});},this.config.durationMs);
  await bounded(signal,()=>this.capability.activate(this.config,signal));this.evidence.activatedAt=new Date().toISOString();
 }
 async recover(signal:AbortSignal):Promise<void>{
  if(this.evidence.recovered)return;
  if(this.restoring)return this.restoring;
  this.restoring=(async()=>{await this.owned(signal);await bounded(signal,()=>this.capability.recover(signal));this.evidence.removedAt=new Date().toISOString();this.evidence.recovered=true;clearTimeout(this.timer);})().finally(()=>{this.restoring=undefined;});
  return this.restoring;
 }
 async cleanup(signal:AbortSignal):Promise<boolean>{
  let failed=false;try{await this.recover(signal);}catch{failed=true;}finally{clearTimeout(this.timer);}
  await this.owned(signal);this.evidence.cleaned=await bounded(signal,()=>this.capability.cleanup(signal));if(failed)throw new Error('ADAPTER_RECOVERY_FAILED');return this.evidence.cleaned;
 }
}
