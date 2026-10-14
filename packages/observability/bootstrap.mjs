// Preload before service dependencies. No auto patches: each operation has one explicit sanitized owner.
import {loadObservabilityConfig} from './config.mjs';
const key=Symbol.for('ecommerce.observability');
const pendingKey=Symbol.for('ecommerce.observability.initializing');
export function initializeTelemetry(env=process.env,overrides={}){
 if(globalThis[pendingKey])return globalThis[pendingKey];
 const promise=initialize(env,overrides);globalThis[pendingKey]=promise;
 void promise.finally(()=>{delete globalThis[pendingKey];});return promise;
}
async function initialize(env,overrides){
 if(globalThis[key])return globalThis[key];
 let config;try{config=loadObservabilityConfig(env);}catch{console.error(JSON.stringify({component:'observability',outcome:'configuration_rejected'}));return {enabled:false,shutdown:async()=>{},flush:async()=>{}};}
 if(!config.enabled)return {enabled:false,shutdown:async()=>{},flush:async()=>{}};
 try{
 const [api,core,resources,node,base,metrics,traces,metricExport]=await Promise.all([import('@opentelemetry/api'),import('@opentelemetry/core'),import('@opentelemetry/resources'),import('@opentelemetry/sdk-trace-node'),import('@opentelemetry/sdk-trace-base'),import('@opentelemetry/sdk-metrics'),import('@opentelemetry/exporter-trace-otlp-http'),import('@opentelemetry/exporter-metrics-otlp-http')]);
 const resource=resources.resourceFromAttributes({'service.name':config.serviceName,'service.namespace':'ecommerce','deployment.environment.name':env.NODE_ENV==='production'?'production':'development'});
 const exporter=overrides.spanExporter??new traces.OTLPTraceExporter({url:config.endpoint.replace(/\/$/,'')+'/v1/traces',timeoutMillis:config.exportTimeoutMs,concurrencyLimit:1});
 const provider=new node.NodeTracerProvider({resource,sampler:new base.ParentBasedSampler({root:new base.TraceIdRatioBasedSampler(config.sampleRatio)}),spanLimits:{attributeCountLimit:16,attributeValueLengthLimit:128,eventCountLimit:0,linkCountLimit:1},spanProcessors:[new base.BatchSpanProcessor(exporter,{maxQueueSize:config.queueSize,maxExportBatchSize:config.batchSize,scheduledDelayMillis:1000,exportTimeoutMillis:config.exportTimeoutMs})]});
 provider.register({propagator:new core.W3CTraceContextPropagator()});
 const reader=overrides.metricReader??new metrics.PeriodicExportingMetricReader({exporter:new metricExport.OTLPMetricExporter({url:config.endpoint.replace(/\/$/,'')+'/v1/metrics',timeoutMillis:config.exportTimeoutMs,concurrencyLimit:1}),exportIntervalMillis:config.intervalMs,exportTimeoutMillis:Math.min(config.intervalMs,config.exportTimeoutMs)});
 const meter=new metrics.MeterProvider({resource,readers:[reader],views:[{instrumentName:'*',aggregationCardinalityLimit:128}]});api.metrics.setGlobalMeterProvider(meter);
 let closing;
 const bounded=async action=>{let timer;try{await Promise.race([Promise.resolve().then(action).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,config.shutdownMs);})]);}finally{clearTimeout(timer);}};
 const state={enabled:true,serviceName:config.serviceName,shutdown:()=>closing??=(async()=>{state.enabled=false;await bounded(()=>Promise.allSettled([provider.shutdown(),meter.shutdown()]));})(),flush:()=>bounded(()=>Promise.allSettled([provider.forceFlush(),meter.forceFlush()]))};globalThis[key]=state;
 // Registered before business shutdown handlers; never owns process exit or changes their deadlines.
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void state.shutdown();});
 return state;
 }catch{console.error(JSON.stringify({component:'observability',outcome:'initialization_failed'}));return {enabled:false,shutdown:async()=>{},flush:async()=>{}};}
}
await initializeTelemetry();
