import {it,expect,vi,afterEach} from 'vitest';
import {OwnedFaultAdapter,adapterConfigSchema,registerLocalResource,verifyOwnership,telemetryEvidenceSchema,type Resource,type OwnedCapability,type AdapterConfig} from '../src/index.js';
const runId='a'.repeat(24),fixture={runId,project:`phase22-${runId}`,marker:'ecommerce-phase22' as const,resources:['postgres','orders','network','consumer','outbox','payments','inventory'] as const};
const base={...fixture,resources:[...fixture.resources]};
const resource:Resource={id:'b'.repeat(64),kind:'container',target:'postgres',labels:{'io.ecommerce.phase22.owner':fixture.marker,'io.ecommerce.phase22.run':runId,'com.docker.compose.project':fixture.project,'io.ecommerce.phase22.target':'postgres'},mounts:['tmpfs']};
const config={kind:'dependency',target:'postgres',durationMs:100};
function capability(){return {target:'postgres' as const,inspect:vi.fn(async()=>resource),activate:vi.fn(async(_config:AdapterConfig,_signal:AbortSignal)=>{}),recover:vi.fn(async()=>{}),cleanup:vi.fn(async()=>true)};}
afterEach(()=>vi.useRealTimers());
it.each([{command:'arbitrary'}, {containerId:'arbitrary'}, {endpoint:'http://prod'}, {durationMs:10001}, {target:'production'}])('strict adapter rejects unsafe configuration %j',extra=>expect(adapterConfigSchema.safeParse({...config,...extra}).success).toBe(false));
it('rechecks ownership immediately before activation, recovery and cleanup',async()=>{const c=capability(),a=new OwnedFaultAdapter(config,base,c);await a.activate(AbortSignal.timeout(1000));await a.recover(AbortSignal.timeout(1000));expect(await a.cleanup(AbortSignal.timeout(1000))).toBe(true);expect(c.inspect).toHaveBeenCalledTimes(3);expect(a.evidence).toMatchObject({recovered:true,cleaned:true});expect(a.evidence.activatedAt).toBeTruthy();expect(a.evidence.removedAt).toBeTruthy();});
it('rejects ownership substitution before a destructive capability executes',async()=>{const c=capability();c.inspect.mockResolvedValue({...resource,labels:{...resource.labels,'io.ecommerce.phase22.run':'foreign'}});const a=new OwnedFaultAdapter(config,base,c);await expect(a.activate(AbortSignal.timeout(1000))).rejects.toThrow();expect(c.activate).not.toHaveBeenCalled();});
it('removes a bounded fault through its watchdog',async()=>{vi.useFakeTimers();const c=capability(),a=new OwnedFaultAdapter({...config,durationMs:10},base,c);await a.activate(new AbortController().signal);await vi.advanceTimersByTimeAsync(10);expect(c.recover).toHaveBeenCalledOnce();await a.cleanup(new AbortController().signal);});
it('still cleans when explicit recovery fails',async()=>{const c=capability();c.recover.mockRejectedValue(new Error());const a=new OwnedFaultAdapter(config,base,c);await a.activate(AbortSignal.timeout(1000));await expect(a.cleanup(AbortSignal.timeout(1000))).rejects.toThrow('ADAPTER_RECOVERY_FAILED');expect(c.cleanup).toHaveBeenCalledOnce();});
it('cleans after activation is cancelled',async()=>{const c=capability();c.activate.mockImplementation(async(_config:unknown,signal?:AbortSignal)=>new Promise<void>((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(new Error()),{once:true})));const a=new OwnedFaultAdapter(config,base,c as OwnedCapability);await expect(a.activate(AbortSignal.timeout(20))).rejects.toThrow();expect(await a.cleanup(AbortSignal.timeout(1000))).toBe(true);});
it('local resource receipts cannot be forged through JSON',()=>{const r=registerLocalResource(base,'orders','process',{});expect(()=>verifyOwnership(base,r)).not.toThrow();expect(()=>verifyOwnership(base,JSON.parse(JSON.stringify(r)))).toThrow('LOCAL_OWNERSHIP_REJECTED');});
it('cannot bind an adapter to another capability target',()=>expect(()=>new OwnedFaultAdapter({...config,target:'redis'},base,capability())).toThrow());
it.each([
 {kind:'process',target:'outbox',operation:'interrupt',durationMs:100},
 {kind:'process',target:'consumer',operation:'restart',durationMs:100},
 {kind:'network',target:'network',operation:'timeout',durationMs:100},
 {kind:'network',target:'network',operation:'connection_reset',durationMs:100},
 {kind:'delivery',target:'consumer',operation:'duplicate',copies:6,delayMs:0,durationMs:100},
 {kind:'delivery',target:'consumer',operation:'delivery_delay',copies:1,delayMs:50,durationMs:100},
])('validates concrete adapter configuration %j',input=>expect(adapterConfigSchema.parse(input)).toEqual(input));
it('does not call missing telemetry verified',()=>expect(telemetryEvidenceSchema.safeParse({status:'verified',scope:'phase17-sdk-in-process-export',activatedAt:null,removedAt:null,recoveryDurationMs:0,traces:[],metrics:[],reason:'collected'}).success).toBe(false));
it('records unavailable telemetry without invented trace references',()=>expect(telemetryEvidenceSchema.parse({status:'unavailable',scope:'phase17-sdk-in-process-export',activatedAt:null,removedAt:null,recoveryDurationMs:0,traces:[],metrics:[],reason:'sdk-unavailable'}).status).toBe('unavailable'));
it('rejects zero trace identities rather than accepting fabricated references',()=>{
 expect(telemetryEvidenceSchema.safeParse({status:'verified',scope:'phase17-sdk-in-process-export',activatedAt:'2026-01-01T00:00:00.000Z',removedAt:'2026-01-01T00:00:00.001Z',recoveryDurationMs:1,traces:[{traceId:'0'.repeat(32),spanId:'0'.repeat(16),name:'resilience.scenario'}],metrics:[{name:'resilience.scenarios',value:1,attributes:{fault:'timeout',target:'network',outcome:'success'}}],reason:'collected'}).success).toBe(false);
});
