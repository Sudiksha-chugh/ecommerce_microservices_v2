import {InMemorySpanExporter} from '@opentelemetry/sdk-trace-base';
import {InMemoryMetricExporter,PeriodicExportingMetricReader,AggregationTemporality} from '@opentelemetry/sdk-metrics';
import {metrics} from '@opentelemetry/api';
import {operation,correlation} from '../packages/observability/src/index.ts';
import {telemetryEvidenceSchema} from '../packages/resilience-testing/src/telemetry.ts';
// This is the Phase 17 SDK/bootstrap with bounded test exporters, not a second stack.
export async function createScenarioTelemetry(){
 if(globalThis[Symbol.for('ecommerce.observability')])throw new Error('TEST_TELEMETRY_ALREADY_INITIALIZED');
 const previousEnabled=process.env.OTEL_ENABLED;process.env.OTEL_ENABLED='false';let initializeTelemetry;try{({initializeTelemetry}=await import('../packages/observability/bootstrap.mjs'));}finally{if(previousEnabled===undefined)delete process.env.OTEL_ENABLED;else process.env.OTEL_ENABLED=previousEnabled;}

 const exporter=new InMemorySpanExporter(),metricExporter=new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),reader=new PeriodicExportingMetricReader({exporter:metricExporter,exportIntervalMillis:10000});
 const sdk=await initializeTelemetry({OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'resilience-fixture',OTEL_TRACES_SAMPLER_ARG:'1',OTEL_BSP_MAX_QUEUE_SIZE:'2048',OTEL_BSP_MAX_EXPORT_BATCH_SIZE:'128'}, {spanExporter:exporter,metricReader:reader});
 const meter=metrics.getMeter('ecommerce.resilience-tests'),counter=meter.createCounter('resilience.scenarios'),duration=meter.createHistogram('resilience.duration',{unit:'ms'});
 const evidence=[],previous=new Map();
 async function record(id,fault,target,action){
  const start=Date.now();let traceId,activatedAt=null,removedAt=null,recoveryStart=null,outcome='success',result,error;
  const lifecycle={activate:()=>{activatedAt??=new Date().toISOString();},remove:()=>{removedAt=new Date().toISOString();},recovering:()=>{recoveryStart=Date.now();}};
  try{result=await operation('resilience.scenario',{'resilience.scenario':id,'fault':fault,'target':target},async()=>{traceId=correlation().traceId;return action(lifecycle);});}catch(e){outcome='error';error=e;}
  counter.add(1,{fault,target,outcome});duration.record(Date.now()-start,{fault,target,outcome});await sdk.flush();
  const spans=exporter.getFinishedSpans().filter(s=>s.spanContext().traceId===traceId).slice(-16).map(s=>({traceId:s.spanContext().traceId,spanId:s.spanContext().spanId,name:s.name.slice(0,100)}));
  const collection=await reader.collect().catch(()=>({resourceMetrics:{scopeMetrics:[]}}));const samples=[];
  for(const scope of collection.resourceMetrics.scopeMetrics)for(const m of scope.metrics){if(!['resilience.scenarios','resilience.duration','business.observations','dependency.operation.duration','http.client.request.duration'].includes(m.descriptor.name))continue;for(const point of m.dataPoints){if(m.descriptor.name.startsWith('resilience.')&&(point.attributes.fault!==fault||point.attributes.target!==target||point.attributes.outcome!==outcome))continue;const value=typeof point.value==='number'?point.value:point.value.sum;if(Number.isFinite(value)){const key=m.descriptor.name+JSON.stringify(point.attributes),prior=previous.get(key)??0;previous.set(key,value);samples.push({name:m.descriptor.name,value:value-prior,attributes:Object.fromEntries(Object.entries(point.attributes).filter(([k])=>['fault','target','outcome','operation','db.system.name','http.request.method'].includes(k)))});}}}
  const reason=!sdk.enabled?'sdk-unavailable':!spans.length?'no-exported-trace':!samples.length?'no-collected-metrics':!activatedAt||!removedAt?'missing-lifecycle':'collected';
  const telemetry=telemetryEvidenceSchema.parse({status:reason==='collected'?'verified':'unavailable',scope:'phase17-sdk-in-process-export',activatedAt,removedAt,recoveryDurationMs:recoveryStart&&removedAt?Math.max(0,Date.parse(removedAt)-recoveryStart):0,traces:spans,metrics:samples.filter(s=>s.value>0).sort((a,b)=>Number(b.name.startsWith('resilience.'))-Number(a.name.startsWith('resilience.'))).slice(0,16),reason});
  evidence.push({scenarioId:id,status:error?'failed':'passed',telemetry});
  exporter.reset();metricExporter.reset();if(error)throw error;return {result,telemetry};
 }
 return {record,evidence,shutdown:()=>sdk.shutdown()};
}
