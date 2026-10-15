// Fresh-process disabled mode: original identities, errors, headers and HTTP middleware contract.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
process.env.OTEL_ENABLED='false';process.env.OTEL_EXPORTER_OTLP_ENDPOINT='invalid';
let sdkImports=0;const hooks=registerHooks({resolve(specifier,context,next){if(/^@opentelemetry\/(sdk-|exporter-)/.test(specifier)){sdkImports++;throw new Error('Disabled mode must not load SDK/exporter');}return next(specifier,context);}});
const {initializeTelemetry}=await import('../bootstrap.mjs');
const {httpTelemetry,instrumentPg,instrumentRedis,telemetryFetch,operation,dependencyOperation,messageHeaders,sqlTelemetrySnapshot}=await import('../src/index.js');
assert.equal((await initializeTelemetry()).enabled,false);assert.equal(sdkImports,0);assert.equal((globalThis as Record<symbol,unknown>)[Symbol.for('ecommerce.observability')],undefined);
const pg={query:()=>{}},redis={get:()=>{}};assert.equal(instrumentPg(pg),pg);assert.equal(instrumentRedis(redis),redis);
const headers={'application-metadata':'kept',traceparent:'malformed','x-request-id':'existing'};assert.equal(messageHeaders(headers),headers);
const originalFetch=globalThis.fetch;const init={headers:{authorization:'fixture'},signal:AbortSignal.timeout(1000)};
let fetchCalls=0;const response=new Response('original');globalThis.fetch=(async(input,options)=>{fetchCalls++;assert.equal(input,'http://fixture.invalid');assert.equal(options,init);return response;}) as typeof fetch;
assert.equal(await telemetryFetch('http://fixture.invalid',init),response);assert.equal(fetchCalls,1);globalThis.fetch=originalFetch;
const error=new Error('original business error');await assert.rejects(operation('business',{},async()=>{throw error;}),e=>e===error);await assert.rejects(dependencyOperation('elasticsearch','GET',async()=>{throw error;}),e=>e===error);
const res={locals:{requestId:'unchanged'}};let next=0;httpTelemetry('orders-service')({} as never,res as never,()=>{next++;});assert.equal(next,1);assert.deepEqual(res,{locals:{requestId:'unchanged'}});
assert.equal(sqlTelemetrySnapshot().enabled,false);assert.deepEqual(sqlTelemetrySnapshot().queries,[]);assert.equal(sdkImports,0);hooks.deregister();console.log(JSON.stringify({passed:true,sdkImports,fetchCalls,originalIdentities:true,originalErrors:true,headersUnchanged:true,requestIdUnchanged:true}));
