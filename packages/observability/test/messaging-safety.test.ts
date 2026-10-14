// Actual Messaging implementation with independently controlled AMQP confirms and deliveries.
import {EventEmitter} from 'node:events';
import amqp,{type ChannelModel,type ConsumeMessage} from 'amqplib';
import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {Messaging,serialize} from '@ecommerce/messaging';
import {fixture} from '../../messaging/test/fixture.js';
import {initializeTelemetry} from '../bootstrap.mjs';
import {correlation,operation} from '../src/index.js';
let telemetry:Awaited<ReturnType<typeof initializeTelemetry>>,exportFailures=0;
beforeAll(async()=>{const failed={export(_data:unknown,done:(result:{code:number;error?:Error})=>void){exportFailures++;done({code:1,error:new Error('controlled exporter unavailable')});},shutdown:async()=>{},forceFlush:async()=>{}};telemetry=await initializeTelemetry({OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'messaging-safety',OTEL_TRACES_SAMPLER_ARG:'1'},{spanExporter:failed,metricReader:new PeriodicExportingMetricReader({exporter:failed,exportIntervalMillis:10000})});});
afterAll(async()=>{await telemetry.shutdown();});
const managers:Messaging[]=[];afterEach(async()=>{await Promise.all(managers.splice(0).map(m=>m.stop()));vi.restoreAllMocks();});
async function connected(handler:Parameters<Messaging['register']>[1]){
 let receive:((message:ConsumeMessage|null)=>void)|undefined;
 const channel=Object.assign(new EventEmitter(),{assertExchange:vi.fn(async()=>({})),checkExchange:vi.fn(async()=>({})),assertQueue:vi.fn(async()=>({})),bindQueue:vi.fn(async()=>({})),prefetch:vi.fn(async()=>({})),consume:vi.fn(async(_queue:string,callback:typeof receive)=>{receive=callback;return {consumerTag:'controlled'};}),cancel:vi.fn(async()=>{}),ack:vi.fn(),nack:vi.fn(),close:vi.fn(async()=>{})});
 const publisher=Object.assign(new EventEmitter(),{assertExchange:channel.assertExchange,checkExchange:channel.checkExchange,assertQueue:channel.assertQueue,bindQueue:channel.bindQueue,publish:vi.fn((_exchange:string,_key:string,_bytes:Buffer,_properties:unknown,confirm:(error?:Error)=>void)=>{confirm();return true;})});
 const model=Object.assign(new EventEmitter(),{createConfirmChannel:vi.fn(async()=>publisher),createChannel:vi.fn(async()=>channel),close:vi.fn(async()=>{model.emit('close');}),connection:{stream:{destroy:vi.fn(()=>model.emit('close'))}}});
 vi.spyOn(amqp,'connect').mockResolvedValue(model as unknown as ChannelModel);
 const manager=new Messaging({url:'amqp://test:fixture@127.0.0.1:1/test',queues:['inventory.order-created.v1'],reconnectBaseMs:50,reconnectMaxMs:50,shutdownTimeoutMs:100},['inventory'],()=>{});managers.push(manager);manager.register('inventory.order-created.v1',handler);manager.start();await vi.waitFor(()=>expect(manager.status).toBe('ready'));
 return {manager,channel,publisher,deliver:(headers:Record<string,unknown>,event=fixture())=>{const message={content:serialize(event),fields:{redelivered:false},properties:{headers,contentType:'application/json',messageId:event.eventId,correlationId:event.correlationId}} as ConsumeMessage;receive!(message);return message;}};
}
it.each(['valid','malformed','missing'] as const)('keeps payload IDs, request IDs and manual ACK with %s trace metadata',async mode=>{
 const seen:unknown[]=[];let fields:ReturnType<typeof correlation>|undefined;const transport=await connected(async event=>{seen.push(event);fields=correlation();});
 const event=fixture(),traceId='1'.repeat(32),headers={'application-metadata':'kept','x-request-id':'request-fixture',...(mode==='valid'?{traceparent:'00-'+traceId+'-'+'2'.repeat(16)+'-01'}:mode==='malformed'?{traceparent:'malformed'}:{})};
 const message=transport.deliver(headers,event);await vi.waitFor(()=>expect(transport.channel.ack).toHaveBeenCalledWith(message));expect(seen).toEqual([event]);expect(message.properties.headers).toEqual(headers);expect(fields?.requestId).toBe('request-fixture');expect(fields?.traceId).toMatch(/^[a-f0-9]{32}$/);expect(fields?.traceId===traceId).toBe(mode==='valid');expect(transport.channel.nack).not.toHaveBeenCalled();
 await telemetry.flush();expect(exportFailures).toBeGreaterThan(0);expect(transport.manager.counters.consumed).toBe(1);
});
it('waits for publisher confirm despite telemetry export failure and preserves envelope identifiers',async()=>{
 const transport=await connected(async()=>{}),event=fixture();let confirm!:()=>void,completed=false;transport.publisher.publish.mockImplementation((_exchange,_key,bytes,properties,done)=>{expect(bytes).toEqual(serialize(event));expect(properties).toMatchObject({messageId:event.eventId,correlationId:event.correlationId,persistent:true,mandatory:true,headers:{traceparent:expect.stringMatching(/^00-/)}});confirm=()=>done();return true;});
 const pending=operation('publish-root',{},()=>transport.manager.publish(event)).then(()=>{completed=true;});await vi.waitFor(()=>expect(confirm).toBeTypeOf('function'));expect(completed).toBe(false);confirm();await pending;await telemetry.flush();expect(completed).toBe(true);expect(transport.manager.counters.published).toBe(1);expect(exportFailures).toBeGreaterThan(0);
});
it('preserves retry headers and ACKs only after a confirmed handoff; failed handoff leaves delivery unacknowledged',async()=>{
 const transport=await connected(async()=>{throw new Error('controlled transient handler');});let confirm!:()=>void;transport.publisher.publish.mockImplementation((_exchange,_key,_bytes,_properties,done)=>{confirm=()=>done();return true;});
 const headers={'application-metadata':'kept','retry-count':0,'x-request-id':'request-fixture'},event=fixture();const message=transport.deliver(headers,event);await vi.waitFor(()=>expect(confirm).toBeTypeOf('function'));expect(transport.channel.ack).not.toHaveBeenCalled();expect(transport.publisher.publish.mock.calls[0]?.[2]).toEqual(message.content);expect(transport.publisher.publish.mock.calls[0]?.[3]).toMatchObject({messageId:event.eventId,correlationId:event.correlationId,headers:{...headers,'retry-count':1,traceparent:expect.stringMatching(/^00-/)}});confirm();await vi.waitFor(()=>expect(transport.channel.ack).toHaveBeenCalledWith(message));
 transport.channel.ack.mockClear();transport.publisher.publish.mockImplementation((_exchange,_key,_bytes,_properties,done)=>{done(new Error('controlled confirm failure'));return true;});transport.deliver(headers);await vi.waitFor(()=>expect(transport.manager.status).toBe('reconnecting'));expect(transport.channel.ack).not.toHaveBeenCalled();expect(transport.channel.nack).not.toHaveBeenCalled();
});
