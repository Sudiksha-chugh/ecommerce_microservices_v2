import {testEnvironmentFile} from '../../../test/environment.js';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createServer,connect,type Socket,type Server} from 'node:net';
import type {AddressInfo} from 'node:net';
import {fork,type ChildProcess} from 'node:child_process';
import amqp,{type ChannelModel,type ConfirmChannel,type GetMessage} from 'amqplib';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {Messaging,names,queueSpecs,declareTopology,serialize,PermanentHandlerError,UnroutableMessageError,type Event,type EventHandler} from '../src/index.js';
const testSpecs=["inventory.order-created.v1", "payments.order-created.v1", "orders.inventory-events.v1"].map(name=>{const spec=queueSpecs.find(spec=>spec.name===name);if(!spec)throw new Error("Missing fixture queue");return spec;});
import {fixture} from './fixture.js';
import {rawScenario} from './raw-scenario.js';
vi.setConfig({hookTimeout:60000,testTimeout:30000});
const env=parseEnv(await readFile(testEnvironmentFile('.env.messaging'),'utf8'));
if(!env.RABBITMQ_TEST_PASSWORD)throw new Error('RabbitMQ test credentials required');
async function management(method:string,path:string,body?:object){
 const response=await fetch(`http://127.0.0.1:${env.RABBITMQ_MANAGEMENT_PORT??15673}/api/${path}`,{method,headers:{authorization:'Basic '+Buffer.from(`${env.RABBITMQ_ADMIN_USER}:${env.RABBITMQ_ADMIN_PASSWORD}`).toString('base64'),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw new Error('Isolated broker-management operation failed');const text=await response.text();return text?JSON.parse(text):undefined;
}
const port=Number(env.RABBITMQ_AMQP_PORT??5673);const direct=`amqp://commerce_test:${encodeURIComponent(env.RABBITMQ_TEST_PASSWORD)}@127.0.0.1:${port}/commerce_test`;
let connection:ChannelModel,raw:ConfirmChannel,ns:string;const managers:Messaging[]=[];const children:ChildProcess[]=[];const servers:Server[]=[];const sockets=new Set<Socket>();
const testQueues=testSpecs.map(s=>s.name);const delays=[120,180,240];const logs:Record<string,unknown>[]=[];
const settings=(url=direct) => ({url,namespace:ns,queues:testQueues,retryDelays:delays,reconnectBaseMs:80,reconnectMaxMs:400,confirmTimeoutMs:3000,connectTimeoutMs:2000,shutdownTimeoutMs:300,prefetch:1});
const manager=(handler?:EventHandler,url=direct) => {const m=new Messaging(settings(url),['orders','inventory','payments'],(record) => logs.push(record));if(handler)m.register('inventory.order-created.v1',handler);managers.push(m);return m;};
const ready=async (m:Messaging) => {m.start();await vi.waitFor(() => expect(m.status,JSON.stringify({status:m.status,counters:m.counters})).toBe('ready'),{timeout:30000,interval:25});};
const queue=() => names(ns,testSpecs[0]!).queue;
const dlq=() => names(ns,testSpecs[0]!).dlq;
async function get(name:string){let found:GetMessage|false=false;await vi.waitFor(async () => {found=await raw.get(name,{noAck:false});expect(found).not.toBe(false);},{timeout:30000,interval:30});return found as unknown as GetMessage;}
async function send(bytes:Buffer,headers:Record<string,unknown>={}){await new Promise<void>((resolve,reject) => raw.publish(`${ns}.commerce.events`,'order.created.v1',bytes,{persistent:true,headers},(error:unknown) => error?reject(error):resolve()));}
async function proxy(){const server=createServer((incoming) => {const outgoing=connect(port,'127.0.0.1');sockets.add(incoming);sockets.add(outgoing);incoming.on('error',() => {});outgoing.on('error',() => {});incoming.on('close',() => {sockets.delete(incoming);outgoing.destroy();});outgoing.on('close',() => {sockets.delete(outgoing);incoming.destroy();});incoming.pipe(outgoing);outgoing.pipe(incoming);});await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve));servers.push(server);return {server,url:direct.replace(`:${port}/`,`:${(server.address() as AddressInfo).port}/`)};}
let scenario:Awaited<ReturnType<typeof rawScenario>>|undefined;
beforeEach(async () => {scenario=undefined;scenario=await rawScenario(direct,testQueues,delays);connection=scenario.connection;raw=scenario.raw;ns=scenario.namespace;logs.length=0;});
afterEach(async () => {
 for(const child of children.splice(0))if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>((resolve) => child.once('exit',() => resolve()));child.kill('SIGKILL');await exited;}
 await Promise.all(managers.splice(0).map((m) => m.stop()));for(const socket of sockets)socket.destroy();await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
 // Each scenario owns its connection and namespace; failures cannot poison later hooks.
 if(scenario)await scenario.close();
});
describe('Real RabbitMQ durability and routing',() => {
 it('persists a confirmed event and routes only to explicit consumers',async () => {const m=manager();await ready(m);const e=fixture();await m.publish(e);for(const spec of testSpecs.slice(0,2)){const received=await get(names(ns,spec).queue);expect(received.properties.deliveryMode).toBe(2);expect(JSON.parse(received.content.toString())).toEqual(e);expect(received.properties.messageId).toBe(e.eventId);raw.ack(received);}expect((await raw.checkQueue(names(ns,testSpecs[2]!).queue)).messageCount).toBe(0);expect(m.counters.published).toBe(1);});
 it('handles a real broker negative confirm when an isolated queue is full',async () => {
  const name=`${ns}_limit`,escaped=queue().replaceAll('.','\\.');await management('PUT',`policies/commerce_test/${name}`,{pattern:`^${escaped}$`,definition:{'max-length':1,overflow:'reject-publish'},priority:100,'apply-to':'quorum_queues'});
  try {await vi.waitFor(async () => expect((await management('GET',`queues/commerce_test/${queue()}`)).effective_policy_definition['max-length']).toBe(1),{timeout:10000});const m=manager();await ready(m);await m.publish(fixture());let rejected=false;for(let i=0;i<10;i++){try{await m.publish(fixture());}catch(error){expect(String(error)).toContain('unavailable');rejected=true;break;}}expect(rejected).toBe(true);}
  finally {await management('DELETE',`policies/commerce_test/${name}`);}
 });
 it('detects mandatory unroutable messages even when the broker confirms receipt',async () => {const m=manager();await ready(m);const e={...fixture(),eventType:'order.cancelled',payload:{orderId:randomUUID(),reason:'CUSTOMER_REQUEST',cancelledAt:new Date().toISOString()}};await expect(m.publish(e as Event)).rejects.toThrow(UnroutableMessageError);});
 it('ACKs only after handler success and allows duplicate logical delivery',async () => {let release=() => {};const gate=new Promise<void>((resolve) => {release=resolve;});let seen=0;const m=manager(async () => {seen++;await gate;});await ready(m);const e=fixture();await m.publish(e);await vi.waitFor(() => expect(seen).toBe(1));expect(m.counters.consumed).toBe(0);release();await vi.waitFor(() => expect(m.counters.consumed).toBe(1));await m.publish(e);await vi.waitFor(() => expect(m.counters.consumed).toBe(2));expect(seen).toBe(2);});
 it('preserves event/correlation/payload while retrying with broker delays',async () => {const seen:Array<{event:Event;count:number;time:number}>=[];const m=manager(async (event,context) => {seen.push({event,count:context.retryCount,time:Date.now()});if(context.retryCount<2)throw new Error('private error');});await ready(m);const e=fixture();await m.publish(e);await vi.waitFor(() => expect(m.counters.consumed).toBe(1),{timeout:30000});expect(seen.map((v) => v.count)).toEqual([0,1,2]);expect(seen.every((v) => JSON.stringify(v.event)===JSON.stringify(e))).toBe(true);expect(seen[1]!.time-seen[0]!.time).toBeGreaterThanOrEqual(110);expect(seen[2]!.time-seen[1]!.time).toBeGreaterThanOrEqual(170);expect(JSON.stringify(logs)).not.toContain('private error');});
 it('exhausts three retries and confirms DLQ handoff',async () => {const m=manager(async () => {throw new Error('temporary');});await ready(m);const e=fixture();await m.publish(e);const dead=await get(dlq());expect(JSON.parse(dead.content.toString())).toEqual(e);expect(dead.properties.headers?.['retry-count']).toBe(3);expect(dead.properties.headers?.['failure-classification']).toBe('TRANSIENT_HANDLER_FAILURE');expect(m.counters.retried).toBe(3);raw.ack(dead);});
 it.each([['{','INVALID_JSON'],[JSON.stringify({...fixture(),eventVersion:2}),'UNSUPPORTED_EVENT'],[JSON.stringify({...fixture(),payload:{}}),'INVALID_PAYLOAD']])('dead-letters poison input %s',async (body,code) => {let calls=0;const m=manager(async () => {calls++;});await ready(m);await send(Buffer.from(body));const dead=await get(dlq());expect(dead.content.toString()).toBe(body);expect(dead.properties.headers?.['failure-classification']).toBe(code);expect(calls).toBe(0);raw.ack(dead);});
 it('rejects invalid retry headers and permanent handler failures without retry',async () => {const m=manager(async () => {throw new PermanentHandlerError();});await ready(m);await send(serialize(fixture()),{'retry-count':999});let dead=await get(dlq());expect(dead.properties.headers?.['failure-classification']).toBe('INVALID_RETRY_COUNT');raw.ack(dead);await m.publish(fixture());dead=await get(dlq());expect(dead.properties.headers?.['failure-classification']).toBe('PERMANENT_HANDLER_FAILURE');expect(m.counters.retried).toBe(0);raw.ack(dead);});
 it('bounds a stuck handler, aborts its context, and hands off permanently after finite attempts',async () => {
  let aborted=0;const m=new Messaging({...settings(),handlerTimeoutMs:50},['inventory'],() => {});m.register('inventory.order-created.v1',async (_event,{signal}) => {signal.addEventListener('abort',() => {aborted++;});await new Promise<void>(() => {});});managers.push(m);await ready(m);await m.publish(fixture());const dead=await get(dlq());expect(aborted).toBe(4);expect(dead.properties.headers?.['retry-count']).toBe(3);raw.ack(dead);
 });
 it('replays one valid DLQ event only after explicit operator action',async () => {let permanent=true;const m=manager(async () => {if(permanent)throw new PermanentHandlerError();});await ready(m);const e=fixture();await m.publish(e);const dead=await get(dlq());permanent=false;await m.replay('inventory.order-created.v1',JSON.parse(dead.content.toString()));raw.ack(dead);await vi.waitFor(() => expect(m.counters.consumed).toBe(1));});
});
describe('Connection, channel and handoff recovery',() => {
 it('fails fast when unavailable at startup and reconnects with bounded delays',async () => {const p=await proxy();const proxyPort=(p.server.address() as AddressInfo).port;await new Promise<void>((resolve) => p.server.close(() => resolve()));servers.splice(servers.indexOf(p.server),1);const m=manager(undefined,p.url);m.start();await expect(m.publish(fixture())).rejects.toThrow('unavailable');await new Promise((resolve) => setTimeout(resolve,250));expect(m.counters.reconnections).toBeLessThan(6);await new Promise<void>((resolve) => p.server.listen(proxyPort,'127.0.0.1',resolve));servers.push(p.server);await vi.waitFor(() => expect(m.status,JSON.stringify({status:m.status,counters:m.counters})).toBe('ready'),{timeout:30000});await m.publish(fixture());});
 it('bounds in-memory pending publications while confirms are blocked',async () => {
  const p=await proxy();const m=new Messaging({...settings(p.url),maxPending:1},['orders','inventory','payments'],() => {});managers.push(m);await ready(m);
  for(const socket of sockets)if(socket.remotePort===port)socket.pause();const first=m.publish(fixture());await expect(m.publish(fixture())).rejects.toThrow('unavailable');for(const socket of sockets)if(socket.remotePort===port)socket.resume();await first;
 });
 it('recovers a broker-link interruption without duplicate active consumers',async () => {
  const p=await proxy();let calls=0,release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const m=manager(async()=>{calls++;if(calls===1)await gate;},p.url);await ready(m);
  try{
   await m.publish(fixture());await vi.waitFor(()=>expect(calls).toBe(1));
   // Handler entry is not an ACK barrier: observe the held delivery, then its ACK.
   const state=()=>management('GET',`queues/commerce_test/${encodeURIComponent(queue())}`);
   await vi.waitFor(async()=>expect((await state()).messages_unacknowledged).toBe(1),{timeout:30000});
   release();await vi.waitFor(()=>expect(m.counters.consumed).toBe(1));
   await vi.waitFor(async()=>expect((await state()).messages_unacknowledged).toBe(0),{timeout:30000});
   for(const socket of sockets)socket.destroy();await vi.waitFor(()=>expect(m.counters.reconnections).toBeGreaterThan(1));await ready(m);
   expect((await raw.checkQueue(queue())).consumerCount).toBe(1);await m.publish(fixture());await vi.waitFor(()=>expect(calls).toBe(2));
  }finally{release();}
 });
 it.each(['retry','dead'] as const)('does not ACK when %s handoff is unroutable',async (target) => {
  let fail=true,calls=0;const m=manager(async () => {calls++;if(fail){if(target==='dead')throw new PermanentHandlerError();throw new Error('temporary');}});await ready(m);
  const n=names(ns,testSpecs[0]!),key=target==='retry'?`${testSpecs[0]!.name}.retry.1`:`${testSpecs[0]!.name}.dead`,destination=target==='retry'?`${n.queue}.retry.1`:n.dlq;
  await raw.unbindQueue(destination,n.handoff,key);await send(serialize(fixture()));await vi.waitFor(() => expect(logs.some((v) => v.outcome==='handoff_failed')).toBe(true));fail=false;await vi.waitFor(() => expect(m.counters.consumed).toBe(1),{timeout:30000});expect(calls).toBeGreaterThanOrEqual(2);expect((await raw.checkQueue(queue())).consumerCount).toBe(1);
 });
 it('fails an interrupted in-flight publication and recovers without a stale publisher',async () => {
  const p=await proxy();const m=manager(undefined,p.url);await ready(m);const event=fixture();const publication=m.publish(event);for(const socket of sockets)socket.destroy();await expect(publication).rejects.toThrow('unavailable');
  await vi.waitFor(() => expect(m.counters.reconnections).toBeGreaterThan(1));await vi.waitFor(() => expect(m.status,JSON.stringify({status:m.status,counters:m.counters})).toBe('ready'),{timeout:30000});await m.publish(event);const received=await get(queue());expect(JSON.parse(received.content.toString()).eventId).toBe(event.eventId);raw.ack(received);
 });
 it('recovers from consumer cancellation and re-registers exactly once',async () => {
  let calls=0;const m=manager(async () => {calls++;});await ready(m);await raw.deleteQueue(queue());await vi.waitFor(() => expect(m.counters.reconnections).toBeGreaterThan(1));await vi.waitFor(() => expect(m.status,JSON.stringify({status:m.status,counters:m.counters})).toBe('ready'),{timeout:30000});expect((await raw.checkQueue(queue())).consumerCount).toBe(1);await m.publish(fixture());await vi.waitFor(() => expect(calls).toBe(1));
 });
 it('bounds shutdown with a blocked cancellation reply and preserves unacknowledged work',async()=>{
  const p=await proxy();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let received=false;
  const m=manager(async()=>{received=true;await gate;},p.url);await ready(m);const event=fixture();await m.publish(event);await vi.waitFor(()=>expect(received).toBe(true));
  for(const socket of sockets)if(socket.remotePort===port)socket.pause();
  try{
   const started=performance.now();await m.stop();expect(performance.now()-started).toBeLessThan(2000);
   expect(logs.some(record=>record.outcome==='shutdown_deadline'&&record.phase==='cancel_consumers')).toBe(true);
   expect(m.counters.consumed).toBe(0);expect(m.status).toBe('closed');
   const redelivered=await get(queue());expect(redelivered.fields.redelivered).toBe(true);expect(JSON.parse(redelivered.content.toString()).eventId).toBe(event.eventId);raw.ack(redelivered);
  }finally{release();for(const socket of sockets)if(!socket.destroyed)socket.resume();}
 });
 it('returns an unacknowledged delivery after shutdown deadline and does not ACK on stale channels',async () => {let release=() => {};const gate=new Promise<void>((resolve) => {release=resolve;});let received=false;const m=manager(async () => {received=true;await gate;});await ready(m);const e=fixture();await m.publish(e);await vi.waitFor(() => expect(received).toBe(true));await m.stop();const redelivered=await get(queue());expect(redelivered.fields.redelivered).toBe(true);expect(JSON.parse(redelivered.content.toString()).eventId).toBe(e.eventId);release();raw.ack(redelivered);expect(m.status).toBe('closed');});
 it('recovers after a real consumer process crashes before ACK',async () => {
  const child=fork(new URL('./crash-consumer.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,TEST_MESSAGING:JSON.stringify(settings())},stdio:['ignore','ignore','ignore','ipc']});children.push(child);
  await new Promise<void>((resolve,reject) => {child.once('message',() => resolve());child.once('error',reject);setTimeout(() => reject(new Error('Crash consumer startup timeout')),5000).unref();});
  const death=new Promise<void>((resolve) => child.once('exit',() => resolve()));const m=manager();await ready(m);const e=fixture();await m.publish(e);await death;
  const redelivered=await get(queue());expect(redelivered.fields.redelivered).toBe(true);expect(JSON.parse(redelivered.content.toString()).eventId).toBe(e.eventId);raw.ack(redelivered);
 });
});
