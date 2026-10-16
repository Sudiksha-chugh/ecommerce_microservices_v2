import {z} from 'zod';
import {PrometheusCollector} from '../incident/collectors.js';
import {backendEndpoint,boundedJson,SourceError} from '../incident/transport.js';
import {sqlBucketsMs,sqlTelemetrySnapshot} from '../sql-telemetry.js';
import {advisorCandidates} from '../sql-advisor.js';
import {correlation} from '../context.js';
import {parseTrace} from './traces.js';
import {evidence,serviceSchema,transportLimits,digest,type Investigation,type Limits,type Collection,type Source,type SourceStatus,type Evidence} from './schemas.js';
export interface Collector {readonly source:Source;collect(input:Investigation,signal:AbortSignal):Promise<Collection>;}
export const unavailable=(source:Source,reason:SourceStatus['reason']='unsupported'):Collection=>({status:{source,status:'unavailable',reason,collectedAt:new Date().toISOString()},evidence:[],graphs:[]});
export class PerformanceMetrics implements Collector{
 readonly source='metrics' as const;private collector:PrometheusCollector;
 constructor(endpoint:string|undefined,limits:Limits,request:typeof fetch=fetch){this.collector=new PrometheusCollector(endpoint,transportLimits(limits),request);}
 async collect(input:Investigation,signal:AbortSignal):Promise<Collection>{const result=await this.collector.collect({incidentId:'performance',startTime:input.startTime,endTime:input.endTime,services:input.services},signal);const rows:Evidence[]=[];let invalid=false;
 for(const e of result.evidence){if(!['http_latency','throughput','http_errors','database_latency','retries','business_failures'].includes(e.signal))continue;if(e.signal==='http_errors'&&e.value>1){invalid=true;continue;}rows.push(evidence({source:'metrics',service:e.service,startTime:e.startTime,endTime:e.endTime,signal:e.signal as Evidence['signal'],value:e.value,...(e.baseline===undefined?{}:{baseline:e.baseline}),unit:e.signal==='http_latency'||e.signal==='database_latency'?'seconds':e.signal==='http_errors'?'ratio':'per_second',reference:e.reference,quality:'measured'}));}
 const reason=result.reason==='trace_id_required'?'trace_ids_required':result.reason;
 return {status:{source:'metrics',status:invalid?(rows.length?'partial':'unavailable'):result.status,reason:invalid?'invalid_response':reason,collectedAt:result.collectedAt},evidence:rows,graphs:[]};}
}
export class PerformanceTraces implements Collector{
 readonly source='traces' as const;private endpoint:string|undefined;
 constructor(endpoint:string|undefined,private limits:Limits,private request:typeof fetch=fetch){this.endpoint=endpoint===undefined?undefined:backendEndpoint(endpoint);}
 async collect(input:Investigation,signal:AbortSignal):Promise<Collection>{if(!this.endpoint)return unavailable('traces','disabled');if(!input.traceIds.length)return unavailable('traces','trace_ids_required');const graphs:Collection['graphs']=[];let reason:SourceStatus['reason']='ok';
 for(const id of input.traceIds){try{signal.throwIfAborted();const url=new URL('/api/traces/'+id,this.endpoint);url.searchParams.set('start',String(Math.floor(Date.parse(input.startTime)/1000)));url.searchParams.set('end',String(Math.ceil(Date.parse(input.endTime)/1000)));const graph=parseTrace(await boundedJson(url.href,transportLimits(this.limits),signal,this.request),id,input,this.limits);graphs.push(graph);if(graph.issues.length)reason='incomplete_graph';}catch(e){reason=e instanceof SourceError?e.code:signal.aborted?'timeout':'invalid_response';if(signal.aborted)break;}}
 return {status:{source:'traces',status:graphs.length?reason==='ok'?'available':'partial':'unavailable',reason,collectedAt:new Date().toISOString()},evidence:[],graphs};}
}
const finite=z.number().finite().min(0).max(1e15);
const sqlSnapshotSchema=z.object({enabled:z.boolean(),sampleRatio:z.number().min(0).max(1),retentionMs:z.number().int().min(1000).max(3600000),maxFingerprints:z.number().int().min(1).max(32),observed:finite,sampled:finite,dropped:finite,bucketUpperBoundsMs:z.array(z.union([z.literal(sqlBucketsMs),z.literal('+Inf')])).length(sqlBucketsMs.length+1).refine(v=>v.every((x,i)=>x===([...sqlBucketsMs,'+Inf'])[i])),queries:z.array(z.object({fingerprint:z.string().regex(/^q_[a-f0-9]{24}$/),operation:z.enum(['SELECT','INSERT','UPDATE','DELETE','BEGIN','COMMIT','ROLLBACK','WITH','CREATE','ALTER','DROP','OTHER']),sampledCount:finite,errors:finite,slow:finite,totalMs:finite,maxMs:finite,histogram:z.array(finite.int()).length(sqlBucketsMs.length+1),lastSeen:finite}).strict().superRefine((q,c)=>{if(!Number.isInteger(q.sampledCount)||!Number.isInteger(q.errors)||!Number.isInteger(q.slow)||q.histogram.reduce((n,v)=>n+v,0)!==q.sampledCount||q.errors>q.sampledCount||q.slow>q.sampledCount||q.totalMs+0.001<q.maxMs)c.addIssue({code:'custom',message:'Invalid sampled aggregates'});})).max(32).refine(rows=>new Set(rows.map(r=>r.fingerprint)).size===rows.length)}).strict();
export class LocalSqlEvidence implements Collector{
 readonly source='sql' as const;
 constructor(private read:()=>unknown=()=>({service:correlation().service,snapshot:sqlTelemetrySnapshot()}),private now=Date.now){}
 async collect(input:Investigation,signal:AbortSignal):Promise<Collection>{signal.throwIfAborted();const raw=z.object({service:serviceSchema,snapshot:sqlSnapshotSchema}).strict().safeParse(this.read());if(!raw.success)return unavailable('sql','unavailable');const {service,snapshot}=raw.data;if(!snapshot.enabled)return unavailable('sql','disabled');if(!input.services.includes(service))return unavailable('sql','outside_window');const time=this.now();if(time<Date.parse(input.startTime)||time>Date.parse(input.endTime)+5000)return unavailable('sql','outside_window');
 // Phase 18 uses a monotonic retention clock. Do not invent per-sample UTC timestamps,
 // window-specific counts, automatic plans, or trace associations.
 const at=new Date(time).toISOString(),rows:Evidence[]=[];
 for(const candidate of advisorCandidates(snapshot)){const row=snapshot.queries.find(q=>q.fingerprint===candidate.fingerprint)!;if(!row.sampledCount)continue;for(const [signal,value,unit]of [['sql_latency',candidate.maxMs,'ms'],['sql_frequency',candidate.sampledCount,'sampled_count']] as const)rows.push(evidence({source:'sql',service,startTime:at,endTime:at,signal,value,unit,reference:'sql:'+candidate.fingerprint,quality:'sampled',fingerprint:candidate.fingerprint}));}
 return {status:{source:'sql',status:rows.length?'partial':'unavailable',reason:rows.length?'snapshot_scope':'empty',collectedAt:at},evidence:rows,graphs:[]};}
}
const snapshotSchema=z.array(z.object({service:serviceSchema,timestamp:z.iso.datetime({offset:true}),signal:z.enum(['queue_delay_ms','queue_depth','cpu_utilization','memory_pressure','event_loop_lag_ms','pool_utilization']),value:finite}).strict()).max(128);
// Optional operator-approved in-memory numeric snapshots, never API uploads or file paths.
// Default collectors do not fabricate absent queue/resource exporters.
export class ApprovedSnapshots implements Collector{
 private rows:z.infer<typeof snapshotSchema>;
 constructor(readonly source:'resources'|'queues',rows:unknown=[]){this.rows=snapshotSchema.parse(rows);if(this.rows.some(r=>(r.signal.startsWith('queue_')?'queues':'resources')!==source))throw new Error('Snapshot source mismatch');if(this.rows.some(r=>['cpu_utilization','memory_pressure','pool_utilization'].includes(r.signal)&&r.value>1))throw new Error('Invalid utilization');}
 async collect(input:Investigation,_signal:AbortSignal):Promise<Collection>{const rows=this.rows.filter(r=>input.services.includes(r.service)&&Date.parse(r.timestamp)>=Date.parse(input.startTime)&&Date.parse(r.timestamp)<=Date.parse(input.endTime));return {status:{source:this.source,status:rows.length?'partial':'unavailable',reason:rows.length?'snapshot_scope':'unsupported',collectedAt:new Date().toISOString()},evidence:rows.map(r=>evidence({source:this.source,service:r.service,startTime:r.timestamp,endTime:r.timestamp,signal:r.signal,value:r.value,unit:r.signal.endsWith('_ms')?'ms':r.signal==='queue_depth'?'count':'ratio',reference:'snapshot:'+digest(r),quality:'approved_snapshot'})),graphs:[]};}
}
export function defaultCollectors(endpoints:{prometheus?:string;tempo?:string},limits:Limits):Collector[]{return [new PerformanceMetrics(endpoints.prometheus,limits),new PerformanceTraces(endpoints.tempo,limits),new LocalSqlEvidence(),new ApprovedSnapshots('resources'),new ApprovedSnapshots('queues')];}
