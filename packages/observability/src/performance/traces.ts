import {z} from 'zod';
import {evidence,spanSchema,serviceSchema,traceGraphSchema,traceAnalysisSchema,type Investigation,type Limits,type Span,type TraceGraph,type TraceAnalysis,type GraphIssue} from './schemas.js';
// Reuse Phase 20's Tempo envelope validation and identifier decoding, retaining a richer sanitized projection.
import {tempo as tempoEnvelope,hexId} from '../incident/collectors.js';
const attrs=z.array(z.object({key:z.string().max(256),value:z.object({stringValue:z.string().max(8192).optional()}).passthrough()})).max(128);
const routeOperations:Record<string,Span['operation']>={'/checkout':'checkout','/search/products':'search','/auth/login':'authentication','/cart':'cart','/products':'catalog','/payments':'payment','/refunds':'refund','/inventory':'inventory'};
function normalizedOperation(name:unknown,a:Map<string,string>,kind:Span['kind']):Pick<Span,'operation'|'dependency'>{
 const dependency=a.get('db.system.name')??a.get('dependency')??a.get('messaging.system');
 if(dependency==='postgresql')return {operation:'database',dependency};if(dependency==='redis')return {operation:'redis',dependency};if(dependency==='elasticsearch')return {operation:'elasticsearch',dependency};if(dependency==='rabbitmq')return {operation:'messaging',dependency};
 const route=a.get('http.route');if(route&&routeOperations[route])return {operation:routeOperations[route]!,dependency:'none'};
 if(dependency==='http'||kind==='client'&&typeof name==='string'&&/^http (GET|POST|PUT|DELETE|PATCH|HEAD|OTHER)$/.test(name))return {operation:'http',dependency:'http'};
 return {operation:'unknown',dependency:'none'};
}
export function parseTrace(raw:unknown,traceId:string,input:Investigation,limits:Limits):TraceGraph{
 const parsed=tempoEnvelope.parse(raw),batches='batches' in parsed?parsed.batches:parsed.resourceSpans,spans:Span[]=[],issues=new Set<GraphIssue>();let count=0;
 for(const batch of batches){const service=serviceSchema.safeParse(batch.resource.attributes.find(a=>a.key==='service.name')?.value.stringValue);
 for(const group of batch.scopeSpans)for(const sp of group.spans){if(++count>limits.spansPerTrace){issues.add('truncated');continue;}if(!service.success||!input.services.includes(service.data)){issues.add('unselected_service');continue;}
 const id=hexId(sp.spanId,8),tid=hexId(sp.traceId,16),parent=sp.parentSpanId?hexId(sp.parentSpanId,8):undefined;
 if(!id||tid!==traceId||sp.parentSpanId&&!parent){issues.add('invalid_span');continue;}
 const startMs=Number(BigInt(sp.startTimeUnixNano))/1e6,endMs=Number(BigInt(sp.endTimeUnixNano))/1e6;
 if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs>8640000000000000||endMs>8640000000000000){issues.add('invalid_span');continue;}
 if(endMs<startMs){issues.add('negative_duration');continue;}
 if(startMs<Date.parse(input.startTime)-limits.skewMs||endMs>Date.parse(input.endTime)+limits.skewMs){issues.add('outside_window');continue;}
 const rawAttributes=attrs.safeParse(sp.attributes??[]);if(!rawAttributes.success){issues.add('invalid_span');continue;}const a=new Map(rawAttributes.data.filter(x=>typeof x.value.stringValue==='string').map(x=>[x.key,x.value.stringValue!]));
 const kind:Span['kind']=({1:'internal',2:'server',3:'client',4:'producer',5:'consumer',SPAN_KIND_INTERNAL:'internal',SPAN_KIND_SERVER:'server',SPAN_KIND_CLIENT:'client',SPAN_KIND_PRODUCER:'producer',SPAN_KIND_CONSUMER:'consumer'} as Record<string,Span['kind']>)[String(sp.kind)]??'unknown';
 const fingerprint=a.get('db.query.fingerprint'),code=sp.status?.code;
 spans.push(spanSchema.parse({traceId,spanId:id,...(parent?{parentSpanId:parent}:{}),service:service.data,startMs,endMs,kind,...normalizedOperation(sp.name,a,kind),error:code===2||code==='STATUS_CODE_ERROR'?true:code===1||code==='STATUS_CODE_OK'?false:null,...(fingerprint&&/^q_[a-f0-9]{24}$/.test(fingerprint)?{fingerprint}:{})}));
 }}
 if(!spans.length)issues.add('empty');return traceGraphSchema.parse({traceId,spans,issues:[...issues].sort()});
}
export type Interval=readonly [number,number];
export function intervalUnion(intervals:readonly Interval[]):number{
 if(intervals.some(([s,e])=>!Number.isFinite(s)||!Number.isFinite(e)||e<s))throw new Error('Invalid interval');
 const sorted=intervals.filter(([s,e])=>e>s).map(([s,e])=>[s,e] as [number,number]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let total=0,start=0,end=0,first=true;
 for(const [s,e]of sorted){if(first){start=s;end=e;first=false;}else if(s>end){total+=end-start;start=s;end=e;}else end=Math.max(end,e);}return first?0:total+end-start;
}
export function spanEvidence(s:Span){return evidence({source:'traces',service:s.service,startTime:new Date(s.startMs).toISOString(),endTime:new Date(s.endMs).toISOString(),signal:'span_duration',value:s.endMs-s.startMs,unit:'ms',reference:'tempo:'+s.traceId+':'+s.spanId,quality:'measured',traceId:s.traceId,spanId:s.spanId,...(s.fingerprint?{fingerprint:s.fingerprint}:{})});}
export function analyzeTrace(raw:TraceGraph,limits:Limits,input?:Investigation):TraceAnalysis{
 const graph=traceGraphSchema.parse(raw),issues=new Set(graph.issues),byId=new Map<string,Span>(),children=new Map<string,Span[]>();
 for(const s of graph.spans){if(byId.has(s.spanId))issues.add('duplicate_span');byId.set(s.spanId,s);if(s.endMs<s.startMs)issues.add('negative_duration');}
 for(const s of byId.values())if(s.parentSpanId){const parent=byId.get(s.parentSpanId);if(!parent)issues.add('missing_parent');else{const list=children.get(parent.spanId)??[];list.push(s);children.set(parent.spanId,list);if(s.startMs<parent.startMs||s.endMs>parent.endMs)issues.add('clock_skew');}}
 const roots=[...byId.values()].filter(s=>!s.parentSpanId);if(roots.length!==1)issues.add(roots.length?'multiple_roots':'empty');
 for(const s of byId.values()){const seen=new Set<string>();let current:Span|undefined=s,depth=0;while(current){if(seen.has(current.spanId)){issues.add('cycle');break;}seen.add(current.spanId);if(++depth>limits.depth){issues.add('depth_limit');break;}current=current.parentSpanId?byId.get(current.parentSpanId):undefined;}}
 if(input&&input.operation!=='all'&&!graph.spans.some(s=>s.operation===input.operation))issues.add('operation_not_observed');
 const complete=issues.size===0,root=roots[0],valid=[...byId.values()].filter(s=>s.endMs>=s.startMs).sort((a,b)=>a.startMs-b.startMs||a.spanId.localeCompare(b.spanId));
 const rows=valid.map(s=>{const union=intervalUnion((children.get(s.spanId)??[]).map(c=>[Math.max(s.startMs,c.startMs),Math.max(Math.max(s.startMs,c.startMs),Math.min(s.endMs,c.endMs))]));return {...s,evidenceId:spanEvidence(s).evidenceId,durationMs:s.endMs-s.startMs,childUnionMs:union,parentExclusiveMs:complete?Math.max(0,s.endMs-s.startMs-union):null};});
 const path:TraceAnalysis['criticalPath']=[];
 // Partition the observed root envelope. At each boundary choose the latest-finishing
 // active child recursively. This is an estimated dominant timeline, NOT a causal DAG.
 // Every instant belongs to exactly one interval; parallel durations are never added.
 if(complete&&root){const times=[...new Set(valid.flatMap(s=>[s.startMs,s.endMs]))].sort((a,b)=>a-b);for(let i=0;i+1<times.length;i++){const startMs=times[i]!,endMs=times[i+1]!;if(endMs<=startMs||startMs<root.startMs||endMs>root.endMs)continue;let selected=root;
 for(let depth=0;depth<limits.depth;depth++){const active=(children.get(selected.spanId)??[]).filter(c=>c.startMs<=startMs&&c.endMs>=endMs).sort((a,b)=>b.endMs-a.endMs||a.spanId.localeCompare(b.spanId));if(!active.length)break;selected=active[0]!;}
 const last=path.at(-1);if(last&&last.spanId===selected.spanId&&last.endMs===startMs)last.endMs=endMs;else path.push({startMs,endMs,spanId:selected.spanId,service:selected.service,classification:'estimated_dominant_interval'});
 }}
 const serviceContributions=[...new Set(valid.map(s=>s.service))].sort().map(service=>({service,observedUnionMs:intervalUnion(valid.filter(s=>s.service===service).map(s=>[s.startMs,s.endMs])),estimatedDominantMs:complete?path.filter(p=>p.service===service).reduce((n,p)=>n+p.endMs-p.startMs,0):null}));
 const rootChildren=root?(children.get(root.spanId)??[]):[];const overlap=root?Math.max(0,rootChildren.reduce((n,c)=>n+Math.max(0,c.endMs-c.startMs),0)-(rows.find(r=>r.spanId===root.spanId)?.childUnionMs??0)):0;
 return traceAnalysisSchema.parse({traceId:graph.traceId,status:complete?'available':'partial',issues:[...issues].sort(),durationMs:complete&&root?root.endMs-root.startMs:null,observedEnvelopeMs:intervalUnion(valid.map(s=>[s.startMs,s.endMs])),unattributedMs:complete?(rows.find(s=>s.spanId===root?.spanId)?.parentExclusiveMs??0):null,parallelOverlapMs:overlap,spans:rows,criticalPath:path,serviceContributions,algorithm:'observed-envelope-v1',limitations:['A representative trace does not establish workload percentile contributions','The dominant timeline is an estimate because parent links do not encode scheduling dependencies','Parent exclusive time is uncovered by observed child spans and is not attributed to service CPU',...(complete?[]:['Incomplete or skewed graphs suppress duration attribution and dominant paths'])]});
}
