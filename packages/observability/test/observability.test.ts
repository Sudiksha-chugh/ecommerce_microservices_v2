import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {trace,propagation} from '@opentelemetry/api';
import {describe,it,expect,beforeAll,afterAll,vi} from 'vitest';
import express from 'express';
import request from 'supertest';
import {InMemorySpanExporter} from '@opentelemetry/sdk-trace-base';
import {InMemoryMetricExporter,PeriodicExportingMetricReader,AggregationTemporality} from '@opentelemetry/sdk-metrics';
import {initializeTelemetry} from '../bootstrap.mjs';
import {loadObservabilityConfig,httpTelemetry,operation,inject,extract,SpanKind,context,correlation,messageHeaders,instrumentPg,instrumentRedis,telemetryFetch,observeBusiness,afterCommit,committed,rolledBack} from '../src/index.js';
const spans=new InMemorySpanExporter(),metricExporter=new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
let state:Awaited<ReturnType<typeof initializeTelemetry>>;
beforeAll(async()=>{state=await initializeTelemetry({OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'observability-test',OTEL_TRACES_SAMPLER_ARG:'1'},{spanExporter:spans,metricReader:new PeriodicExportingMetricReader({exporter:metricExporter,exportIntervalMillis:10000})});});
afterAll(async()=>{await state.shutdown();});
describe('telemetry configuration',()=>{
 it('disables telemetry without requiring any backend options',()=>expect(loadObservabilityConfig({OTEL_ENABLED:'false',OTEL_EXPORTER_OTLP_ENDPOINT:'not-a-url'})).toEqual({enabled:false}));
 it.each([{OTEL_TRACES_SAMPLER_ARG:'2'},{OTEL_EXPORTER_OTLP_ENDPOINT:'http://secret:password@localhost'},{OTEL_EXPORTER_OTLP_ENDPOINT:'http://localhost?token=secret'},{OTEL_BSP_MAX_QUEUE_SIZE:'99999'},{OTEL_SERVICE_NAME:'user@example.test'}])('rejects unsafe enabled configuration %o',options=>{expect(()=>loadObservabilityConfig({OTEL_ENABLED:'true',...options})).toThrow();});
 it('does not install another provider on duplicate initialization',async()=>expect(await initializeTelemetry({OTEL_ENABLED:'true'})).toBe(state));
});
describe('trace propagation and safe observations',()=>{
 it('ignores malformed trace headers and untrusted baggage',()=>{context.with(extract({traceparent:'invalid',baggage:'customer=secret'}),()=>{expect(trace.getSpanContext(context.active())).toBeUndefined();expect(propagation.getBaggage(context.active())).toBeUndefined();});});
 it('propagates only valid W3C context and preserves application message headers',async()=>{
  await operation('root',{},async()=>{const headers=messageHeaders({'retry-count':2,'publication-id':'unchanged',baggage:'user=private'});expect(headers['retry-count']).toBe(2);expect(headers['publication-id']).toBe('unchanged');expect(messageHeaders({'x-request-id':'existing'})['x-request-id']).toBe('existing');expect(headers.traceparent).toMatch(/^00-/);expect(correlation().traceId).toBeDefined();
   await operation('consumer',{},async()=>{expect(correlation().traceId).toBe((headers.traceparent as string).split('-')[1]);},SpanKind.CONSUMER,extract(headers));
  });await state.flush();const all=spans.getFinishedSpans();const root=all.find(s=>s.name==='root')!,consumer=all.find(s=>s.name==='consumer')!;expect(consumer.spanContext().traceId).toBe(root.spanContext().traceId);expect(consumer.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
 });
 it('records route templates and request IDs without exporting query/body/auth headers',async()=>{
  const app=express();app.use(httpTelemetry('orders-service'));app.get('/orders/:id',(req,res)=>{expect(correlation().requestId).toBe('request-1');res.json({ok:true});});
  await request(app).get('/orders/customer-secret?token=query-secret').set('X-Request-Id','request-1').set('Authorization','Bearer secret').expect(200).expect('X-Request-Id','request-1');await state.flush();
  const recorded=spans.getFinishedSpans().find(s=>s.attributes['http.route']==='/orders/:id')!;expect(recorded.attributes['http.response.status_code']).toBe(200);expect(JSON.stringify(recorded.attributes)).not.toMatch(/customer-secret|query-secret|Bearer|request-1/);
 });
 it('attaches an actual downstream HTTP server to its client span and preserves the request ID',async()=>{
  const peer=express();peer.use(httpTelemetry('orders-service'));peer.get('/telemetry-peer',(_req,res)=>res.json(correlation()));const server=createServer(peer);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const gateway=express();gateway.use(httpTelemetry('api-gateway'));gateway.get('/telemetry-handoff',async(_req,res)=>{const response=await telemetryFetch('http://127.0.0.1:'+(server.address() as AddressInfo).port+'/telemetry-peer',{signal:AbortSignal.timeout(1000)});res.json(await response.json());});
   const response=await request(gateway).get('/telemetry-handoff').expect(200);expect(response.body.requestId).toBe(response.headers['x-request-id']);expect(response.body.traceId).not.toBe(response.body.requestId);await state.flush();
   const all=spans.getFinishedSpans(),root=all.find(s=>s.attributes['http.route']==='/telemetry-handoff')!,downstream=all.find(s=>s.attributes['http.route']==='/telemetry-peer')!,client=all.find(s=>s.name==='http GET'&&s.parentSpanContext?.spanId===root.spanContext().spanId)!;
   expect(downstream.spanContext().traceId).toBe(root.spanContext().traceId);expect(downstream.parentSpanContext?.spanId).toBe(client.spanContext().spanId);
  }finally{await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});}
 });
 it('keeps business errors intact and exports only fixed classification',async()=>{const error=new Error('password=private');await expect(operation('fails',{},async()=>{throw error;})).rejects.toBe(error);await state.flush();const span=spans.getFinishedSpans().find(s=>s.name==='fails')!;expect(JSON.stringify({attributes:span.attributes,events:span.events,status:span.status})).not.toContain('password=private');});
 it('preserves pg Promise/callback and client transaction methods without parameters',async()=>{
  const query=vi.fn(async()=>({rows:[{value:1}]}));const client=instrumentPg({query,release:vi.fn()});expect(await client.query()).toEqual({rows:[{value:1}]});
  const callback=(...args:unknown[])=>{const fn=args.at(-1) as Function;fn(null,{rows:[]});};const pool=instrumentPg({query:callback});const finished=vi.fn();pool.query('SELECT secret', ['private-param'],finished);expect(finished).toHaveBeenCalledWith(null,{rows:[]});await state.flush();expect(JSON.stringify(spans.getFinishedSpans().filter(s=>s.name.startsWith('postgresql')).map(s=>s.attributes))).not.toContain('private-param');
 });
 it('preserves Redis Lua calls without keys or script data',async()=>{const evalCall=vi.fn(async()=>[1]);const client=instrumentRedis({eval:evalCall});expect(await client.eval()).toEqual([1]);expect(evalCall).toHaveBeenCalledOnce();await state.flush();expect(spans.getFinishedSpans().some(s=>s.name==='redis EVAL')).toBe(true);});
 it('counts committed outcomes once and discards rolled-back observations',async()=>{const client={};afterCommit(client,'order_completed','success');rolledBack(client);afterCommit(client,'order_completed','success');committed(client);committed(client);await state.flush();const points=metricExporter.getMetrics().flatMap(m=>m.scopeMetrics.flatMap(s=>s.metrics)).filter(m=>m.descriptor.name==='business.observations').flatMap(m=>m.dataPoints.map(p=>({attributes:p.attributes,value:p.value}))).filter(p=>p.attributes.operation==='order_completed');expect(points.at(-1)?.value).toBe(1);});
 it('instruments Redis command-option clients without changing timeout options',async()=>{const get=vi.fn(async()=> 'stored');const withOptions=vi.fn((_options:{timeout:number})=>({get}));const client=instrumentRedis({withCommandOptions:withOptions});expect(await client.withCommandOptions({timeout:123}).get()).toBe('stored');expect(withOptions).toHaveBeenCalledWith({timeout:123});expect(get).toHaveBeenCalledOnce();await state.flush();expect(spans.getFinishedSpans().some(s=>s.name==='redis GET')).toBe(true);});
 it('records the matched registered template for Express route arrays without exporting path IDs',async()=>{
  const app=express();app.use(httpTelemetry('api-gateway'));app.post(['/checkout','/checkout/:orderId/retry'],(_req,res)=>res.json({ok:true}));
  const logs:Record<string,unknown>[]=[];const log=vi.spyOn(console,'info').mockImplementation(value=>{logs.push(JSON.parse(String(value)));});
  try{await request(app).post('/checkout').expect(200);await request(app).post('/checkout/customer-secret/retry').expect(200);await state.flush();
   const recorded=spans.getFinishedSpans().filter(s=>s.name==='HTTP POST'&&s.attributes['service.name']==='api-gateway');expect(recorded.map(s=>s.attributes['http.route'])).toEqual(['/checkout','/checkout/:orderId/retry']);expect(logs.map(l=>l.route)).toEqual(['/checkout','/checkout/:orderId/retry']);expect(JSON.stringify(recorded.map(s=>s.attributes))).not.toContain('customer-secret');
  }finally{log.mockRestore();}
 });
 it('exports actual instruments with bounded labels',async()=>{observeBusiness('payment_attempt');await state.flush();const metrics=metricExporter.getMetrics().flatMap(m=>m.scopeMetrics.flatMap(s=>s.metrics));expect(metrics.some(m=>m.descriptor.name==='http.server.request.duration')).toBe(true);expect(metrics.some(m=>m.descriptor.name==='business.observations')).toBe(true);expect(JSON.stringify(metrics)).not.toMatch(/customer-secret|query-secret|request-1/);});
});
