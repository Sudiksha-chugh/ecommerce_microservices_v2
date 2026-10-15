import {createHash} from 'node:crypto';
import {z} from 'zod';
import {metrics} from '@opentelemetry/api';
import {operation} from './context.js';
import type {SqlDiagnostics} from './sql-diagnostics.js';
import {sqlTelemetrySnapshot} from './sql-telemetry.js';

const level=z.enum(['low','medium','high']);
const category=z.enum(['sequential_scan','high_cost','large_sort','expensive_join','index_opportunity','high_frequency','high_latency','large_result','query_shape']);
const text=z.string().min(1).max(800).refine(s=>!/[`;\u0000-\u001f]|\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|EXECUTE|curl|https?|password|credential|api.key|ignore.*instructions)\b/i.test(s),'Unsafe advisory text');
const finding=z.object({type:category,evidence:z.string().max(180),explanation:text,recommendation:text,validationSteps:z.array(text).min(1).max(4),confidence:level}).strict();
export const recommendationSchema=z.object({version:z.literal(1),queryFingerprint:z.string().regex(/^q_[a-f0-9]{24}$/),summary:text,severity:level,confidence:level,priorityReasons:z.array(text).max(6),findings:z.array(finding).max(16),limitations:z.array(text).min(1).max(8)}).strict();
export type Recommendation=z.infer<typeof recommendationSchema>;
const finite=z.number().finite().min(0).max(1e15);
const snapshotSchema=z.object({version:z.literal(1),fingerprint:z.string().regex(/^q_[a-f0-9]{24}$/),operation:z.enum(['SELECT','WITH','OTHER']),sampledCount:finite,p95UpperMs:finite.nullable(),maxMs:finite,planSummary:z.object({cost:finite,rows:finite}).strict().optional(),plan:z.array(z.object({node:z.number().int().min(0).max(127),code:z.enum(['sequential_scan','expensive_sort','join','review_filter_index','review_sort_index','review_join_indexes']),cost:finite,rows:finite}).strict()).max(128)}).strict();
export type AdvisorSnapshot=z.infer<typeof snapshotSchema>;
export interface SqlAdvisorProvider {readonly identity:string;analyze(input:AdvisorSnapshot,baseline:Recommendation,signal:AbortSignal):Promise<unknown>}
export class OfflineAdvisorProvider implements SqlAdvisorProvider {readonly identity='offline:v1';async analyze(_input:AdvisorSnapshot,baseline:Recommendation){return structuredClone(baseline);}}
export type AdvisorFailure='disabled'|'timeout'|'unavailable'|'invalid_response'|'busy'|'budget'|'circuit_open';
export class AdvisorProviderError extends Error {constructor(readonly code:AdvisorFailure){super(code);}}
export function baseline(input:AdvisorSnapshot):Recommendation {
 const s=snapshotSchema.parse(input),findings:Recommendation['findings']=[];
 const add=(type:z.infer<typeof category>,evidence:string,explanation:string,recommendation:string)=>{if(!findings.some(f=>f.type===type))findings.push({type,evidence,explanation,recommendation,validationSteps:['Compare representative plans and measured workload latencies before and after a controlled experiment'],confidence:'medium'});};
 if(s.planSummary){const evidence=`plan root estimated cost ${s.planSummary.cost}, estimated rows ${s.planSummary.rows}`;if(s.planSummary.cost>=1000)add('high_cost',evidence,'Estimated cost is elevated and does not establish runtime','Compare estimated work with representative measured latency');if(s.planSummary.rows>=10000)add('large_result',evidence,'Estimated rows are large and actual returned rows are unknown','Review projection, filtering and pagination requirements');}
 for(const p of s.plan){const evidence=`plan node ${p.node}, ${p.code}, estimated cost ${p.cost}, estimated rows ${p.rows}`;
 if(p.code==='sequential_scan')add('sequential_scan',evidence,'A sequential scan is observed and can be appropriate for small or unselective workloads','Investigate scan selectivity and available indexes');
 if(p.cost>=1000)add('high_cost',evidence,'Estimated cost is elevated and does not establish runtime','Compare estimated work with representative measured latency');
 if(p.code==='expensive_sort')add('large_sort',evidence,'A sort has elevated estimated cost with unknown memory use','Investigate filtering, ordering and sort memory requirements');
 if(p.code==='join'&&p.cost>=1000)add('expensive_join',evidence,'A join has elevated estimated cost and may still be appropriate','Review join cardinalities and access paths');
 if(p.code.startsWith('review_'))add('index_opportunity',evidence,'The plan supports investigating access paths but index metadata is unavailable','Review existing indexes and selectivity with write overhead and storage tradeoffs');
 if(p.rows>=10000)add('large_result',evidence,'Estimated rows are large and actual returned rows are unknown','Review projection, filtering and pagination requirements');
 }
 if(s.sampledCount>=1000){add('high_frequency',`telemetry sampled executions ${s.sampledCount}`,'Many sampled executions are observed but request correlation is unavailable','Investigate batching, caching and request fan out');add('query_shape',`telemetry sampled executions ${s.sampledCount}`,'Repeated work may justify reviewing query shape without proving a repeated request pattern','Review batching and projection against representative application behavior');}
 if(s.p95UpperMs!==null&&s.p95UpperMs>=100)add('high_latency',`telemetry p95 bucket upper bound ${s.p95UpperMs} ms`,'A sampled latency histogram indicates an elevated upper bound rather than an exact percentile','Measure representative latency and compare plans under controlled load');
 const reasons:string[]=[];if(s.sampledCount>=1000)reasons.push('High sampled execution frequency');if(s.p95UpperMs!==null&&s.p95UpperMs>=100)reasons.push('Elevated sampled latency bucket');if((s.planSummary?.cost??0)>=1000||s.plan.some(p=>p.cost>=1000))reasons.push('Elevated estimated plan cost');
 return recommendationSchema.parse({version:1,queryFingerprint:s.fingerprint,summary:findings.length?'Review the evidence before testing workload changes':'Insufficient evidence for optimization recommendations',severity:reasons.length>=2?'high':findings.length?'medium':'low',confidence:s.plan.length||s.planSummary?'medium':'low',priorityReasons:reasons,findings,limitations:['AI recommendations are advisory and must be validated against representative workloads before production adoption','Sampled counts are not total workload frequency and histogram bounds are not exact percentiles','Generic plans contain estimates only and cannot establish row estimate accuracy or actual resource use','Request correlation and index metadata are unavailable, so repeated request patterns and missing indexes cannot be established']});
}
// Reviewed narrative choices make unsupported factual claims impossible to accept as enrichment.
// A model can select a fuller explanation, but arbitrary prose never crosses this boundary.
export function enrichmentOptions(source:Recommendation){
 const details:Record<z.infer<typeof category>,string>={sequential_scan:'Scan efficiency depends on selectivity and workload size',high_cost:'Planner cost units cannot be translated directly into elapsed milliseconds',large_sort:'Estimated sort work does not establish a measured memory spill',expensive_join:'A join strategy can be appropriate depending on cardinality and available access paths',index_opportunity:'Existing index coverage must be inspected and any experiment must account for write overhead',high_frequency:'Sampled repetition alone cannot establish a repeated query pattern within a request',high_latency:'Histogram bucket boundaries provide only approximate latency evidence',large_result:'Estimated cardinality does not establish the number of rows delivered to an application',query_shape:'Query shape changes require application correctness checks and representative measurement'};
 return {summaries:[source.summary,'Review the supported investigations with representative measurements and retain all stated limitations'],findings:source.findings.map(f=>({explanations:[f.explanation,f.explanation+'. '+details[f.type]],recommendations:[f.recommendation],validationSteps:[...f.validationSteps,'Record correctness and workload measurements before considering production adoption']}))};
}
export function validateEnrichment(value:unknown,source:Recommendation):Recommendation {
 if(JSON.stringify(value)?.length>24000)throw new AdvisorProviderError('invalid_response');
 const out=recommendationSchema.parse(value),allowed=enrichmentOptions(source);
 if(!allowed.summaries.includes(out.summary))throw new AdvisorProviderError('invalid_response');
 // The model may explain supported findings, but cannot invent evidence, change priorities or remove caveats.
 if(out.queryFingerprint!==source.queryFingerprint||out.severity!==source.severity||out.confidence!==source.confidence||JSON.stringify(out.priorityReasons)!==JSON.stringify(source.priorityReasons)||JSON.stringify(out.limitations)!==JSON.stringify(source.limitations)||out.findings.length!==source.findings.length)throw new AdvisorProviderError('invalid_response');
 if(/\b(?:missing index|guaranteed|proven improvement|must run|execute|ignore.*instructions)\b/i.test(JSON.stringify(out)))throw new AdvisorProviderError('invalid_response');
 out.findings.forEach((f,i)=>{const original=source.findings[i]!,choices=allowed.findings[i]!;if(!choices.explanations.includes(f.explanation)||!choices.recommendations.includes(f.recommendation)||!f.validationSteps.every(step=>choices.validationSteps.includes(step)))throw new AdvisorProviderError('invalid_response');if(f.type!==original.type||f.evidence!==original.evidence||f.confidence!==original.confidence||/\b(?:missing index|guaranteed|proven improvement|must run|execute)\b/i.test(JSON.stringify(f)))throw new AdvisorProviderError('invalid_response');});return out;
}
export interface AdvisorConfig {enabled:boolean;timeoutMs:number;maxConcurrent:number;cacheTtlMs:number;cacheEntries:number;requestsPerMinute:number;maxOutputTokens:number;tokensPerMinute:number}
export function advisorConfig(env:NodeJS.ProcessEnv=process.env):AdvisorConfig {
 const n=(key:string,d:number,max:number)=>{const v=Number(env[key]??d);if(!Number.isInteger(v)||v<1||v>max)throw new Error('Invalid advisor configuration');return v;};
 return {enabled:env.SQL_ADVISOR_AI_ENABLED==='true',timeoutMs:n('SQL_ADVISOR_TIMEOUT_MS',3000,10000),maxConcurrent:n('SQL_ADVISOR_MAX_CONCURRENT',2,4),cacheTtlMs:n('SQL_ADVISOR_CACHE_TTL_MS',60000,3600000),cacheEntries:n('SQL_ADVISOR_CACHE_ENTRIES',32,128),requestsPerMinute:n('SQL_ADVISOR_REQUESTS_PER_MINUTE',10,60),maxOutputTokens:n('SQL_ADVISOR_MAX_OUTPUT_TOKENS',2000,4000),tokensPerMinute:n('SQL_ADVISOR_TOKENS_PER_MINUTE',100000,1000000)};
}
const meter=metrics.getMeter('ecommerce.sql-advisor','1');
const requests=meter.createCounter('sql_advisor_requests_total'),errors=meter.createCounter('sql_advisor_provider_errors_total'),invalid=meter.createCounter('sql_advisor_validation_failures_total'),fallback=meter.createCounter('sql_advisor_fallback_total'),inflight=meter.createUpDownCounter('sql_advisor_inflight_requests'),duration=meter.createHistogram('sql_advisor_analysis_duration_seconds',{unit:'s'});
function safeMetric(fn:()=>void){try{fn();}catch{/* Observability cannot affect diagnostics. */}}
export interface AnalysisResult {recommendation:Recommendation;enrichment:'disabled'|'success'|'failed';failure?:AdvisorFailure}
export class SqlAdvisor {
 private cache=new Map<string,{expires:number;value:AnalysisResult}>();private pending=new Map<string,Promise<AnalysisResult>>();private admissions:number[]=[];private providerActive=0;private failures=0;private openUntil=0;
 constructor(private config:AdvisorConfig,private provider?:SqlAdvisorProvider,private now=Date.now){
  this.config=Object.freeze({...config});
  // Validate programmatic configuration with the same bounds as environment configuration.
  const keys:Record<string,string>={timeoutMs:'SQL_ADVISOR_TIMEOUT_MS',maxConcurrent:'SQL_ADVISOR_MAX_CONCURRENT',cacheTtlMs:'SQL_ADVISOR_CACHE_TTL_MS',cacheEntries:'SQL_ADVISOR_CACHE_ENTRIES',requestsPerMinute:'SQL_ADVISOR_REQUESTS_PER_MINUTE',maxOutputTokens:'SQL_ADVISOR_MAX_OUTPUT_TOKENS',tokensPerMinute:'SQL_ADVISOR_TOKENS_PER_MINUTE'};
  advisorConfig(Object.fromEntries(Object.entries(keys).map(([k,v])=>[v,String(config[k as keyof AdvisorConfig])])));
  if(config.enabled&&!provider)throw new Error('Advisor provider required');
 }
 health(){return {aiEnabled:this.config.enabled,circuitOpen:this.now()<this.openUntil,inflight:this.pending.size};}
 async analyze(raw:AdvisorSnapshot):Promise<AnalysisResult>{
  const input=snapshotSchema.parse(raw),base=baseline(input);safeMetric(()=>requests.add(1));
  if(!this.config.enabled)return {recommendation:base,enrichment:'disabled'};
  const key=createHash('sha256').update(JSON.stringify([1,this.provider!.identity,input])).digest('hex'),now=this.now();
  for(const [k,v] of this.cache)if(v.expires<=now)this.cache.delete(k);
  const hit=this.cache.get(key);if(hit)return structuredClone(hit.value);const pending=this.pending.get(key);if(pending)return structuredClone(await pending);
  const failed=(failure:AdvisorFailure):AnalysisResult=>{try{console.info(JSON.stringify({component:'sql-advisor',outcome:'enrichment_failed',reason:failure}));}catch{}safeMetric(()=>fallback.add(1,{reason:failure}));return {recommendation:base,enrichment:'failed',failure};};
  this.admissions=this.admissions.filter(t=>t>now-60000);
  if(now<this.openUntil)return failed('circuit_open');if(this.pending.size>=this.config.maxConcurrent||this.providerActive>=this.config.maxConcurrent)return failed('busy');
  // Reserve a conservative input allowance plus the full output allocation for every attempt.
  if(this.admissions.length>=this.config.requestsPerMinute||(this.admissions.length+1)*(this.config.maxOutputTokens+32768)>this.config.tokensPerMinute)return failed('budget');
  this.admissions.push(now);
  const job=(async()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const start=performance.now();safeMetric(()=>inflight.add(1));
   return operation('sql-advisor.analyze',{},async()=>{try{
    const output=await Promise.race([Promise.resolve().then(()=>{this.providerActive++;return this.provider!.analyze(structuredClone(input),structuredClone(base),controller.signal);}).finally(()=>{this.providerActive--;}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new AdvisorProviderError('timeout'));},this.config.timeoutMs);})]);
    let recommendation:Recommendation;try{recommendation=validateEnrichment(output,base);}catch{safeMetric(()=>invalid.add(1));throw new AdvisorProviderError('invalid_response');}
    this.failures=0;const result:AnalysisResult={recommendation,enrichment:'success'};if(this.cache.size>=this.config.cacheEntries)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,{expires:this.now()+this.config.cacheTtlMs,value:structuredClone(result)});return result;
   }catch(error){const code=error instanceof AdvisorProviderError?error.code:'unavailable';safeMetric(()=>errors.add(1,{reason:code}));if(++this.failures>=3)this.openUntil=this.now()+30000;return failed(code);
   }finally{clearTimeout(timer);controller.abort();safeMetric(()=>{inflight.add(-1);duration.record((performance.now()-start)/1000);});}});
  })();this.pending.set(key,job);try{return structuredClone(await job);}finally{this.pending.delete(key);}
 }
}
// No raw SQL or arbitrary plan input is accepted. All text is replaced by reviewed enums/digests.
export function advisorCandidates(snapshot=sqlTelemetrySnapshot()) {
 return snapshot.queries.slice(0,32).map(q=>{
  let cumulative=0,p95UpperMs:number|null=null;for(let i=0;i<q.histogram.length;i++){cumulative+=q.histogram[i]!;if(cumulative>=q.sampledCount*0.95){const bound=snapshot.bucketUpperBoundsMs[i];p95UpperMs=typeof bound==='number'?bound:null;break;}}
  return snapshotSchema.parse({version:1,fingerprint:q.fingerprint,operation:['SELECT','WITH'].includes(q.operation)?q.operation:'OTHER',sampledCount:q.sampledCount,p95UpperMs,maxMs:q.maxMs,plan:[]});
 }).sort((a,b)=>{const rank={low:0,medium:1,high:2};return rank[baseline(b).severity]-rank[baseline(a).severity]||a.fingerprint.localeCompare(b.fingerprint);});
}
export async function approvedPlanSnapshot(diagnostics:SqlDiagnostics,queryId:string):Promise<AdvisorSnapshot>{
 const plan=await diagnostics.explain(queryId);
 // Approved templates have no known mapping to workload fingerprints. Never fabricate that correlation.
 return snapshotSchema.parse({version:1,fingerprint:'q_'+createHash('sha256').update('approved-template:'+queryId).digest('hex').slice(0,24),operation:'SELECT',sampledCount:0,p95UpperMs:null,maxMs:0,planSummary:{cost:plan.nodes[0]!.estimatedCost,rows:plan.nodes[0]!.estimatedRows},plan:plan.findings.slice(0,128).map(f=>({node:f.node,code:f.code,cost:plan.nodes[f.node]!.estimatedCost,rows:plan.nodes[f.node]!.estimatedRows}))});
}
