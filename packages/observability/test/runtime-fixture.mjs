import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {initializeTelemetry} from '../bootstrap.mjs';
import {trace,metrics} from '@opentelemetry/api';
const mode=process.argv[2];
const start=performance.now();
if(mode==='disabled'||mode==='invalid'){
 const state=await initializeTelemetry({OTEL_ENABLED:mode==='disabled'?'false':'true',OTEL_EXPORTER_OTLP_ENDPOINT:'invalid'});assert.equal(state.enabled,false);assert.equal(globalThis[Symbol.for('ecommerce.observability')],undefined);
}else{
 let exported=0;
 const exporter={export(spans,callback){exported+=spans.length;if(mode==='queue')callback({code:0});},shutdown:async()=>{if(mode==='shutdown')await new Promise(()=>{});}};
 const state=await initializeTelemetry({OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'runtime-test',OTEL_EXPORTER_OTLP_ENDPOINT:'http://127.0.0.1:1',OTEL_TRACES_SAMPLER_ARG:'1',OTEL_BSP_MAX_QUEUE_SIZE:'8',OTEL_BSP_MAX_EXPORT_BATCH_SIZE:'4',OTEL_EXPORTER_OTLP_TIMEOUT:'50',OTEL_SHUTDOWN_TIMEOUT_MS:'100'},mode==='unavailable'?{}:{spanExporter:exporter});
 assert.equal(state.enabled,true);const tracer=trace.getTracer('runtime-test');for(let i=0;i<1000;i++)tracer.startSpan('business-operation').end();metrics.getMeter('runtime-test').createCounter('business.fixture').add(1);
 await state.flush();await state.shutdown();assert.equal(state.enabled,false);assert.equal(await initializeTelemetry({OTEL_ENABLED:'true'}),state);assert.ok(performance.now()-start<2000);if(mode==='queue')assert.ok(exported<1000&&exported>0);
}
console.log(JSON.stringify({mode,passed:true,durationMs:performance.now()-start}));
