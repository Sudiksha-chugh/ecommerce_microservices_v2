import {testEnvironmentFile} from '../../../test/environment.js';
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fork,type ChildProcess} from 'node:child_process';
import amqp,{type ChannelModel,type ConfirmChannel} from 'amqplib';
import {beforeAll,beforeEach,afterEach,afterAll,describe,it,expect,vi} from 'vitest';
import {Messaging,names,queueSpecs,type Event} from '@ecommerce/messaging';
const testSpecs=["inventory.order-created.v1", "payments.order-created.v1"].map(name=>{const spec=queueSpecs.find(spec=>spec.name===name);if(!spec)throw new Error("Missing fixture queue");return spec;});
import {createEvent,InboxProcessor,OutboxRepository,OutboxWorker,receiptHandlers} from '../src/index.js';
import {OrderRepository} from '../../../apps/orders-service/src/order-repository.js';
import {isolated} from './setup.js';
vi.setConfig({hookTimeout:60000,testTimeout:30000});
const env=parseEnv(await readFile(testEnvironmentFile('.env.messaging'),'utf8')),url=`amqp://commerce_test:${encodeURIComponent(env.RABBITMQ_TEST_PASSWORD!)}@127.0.0.1:${env.RABBITMQ_AMQP_PORT??5673}/commerce_test`;
let orders:Awaited<ReturnType<typeof isolated>>,inventory:Awaited<ReturnType<typeof isolated>>,payments:Awaited<ReturnType<typeof isolated>>;
let connection:ChannelModel,raw:ConfirmChannel,ns:string;const managers:Messaging[]=[],workers:OutboxWorker[]=[],children:ChildProcess[]=[];
const productId=randomUUID(),userId=randomUUID(),snapshot={totalAmountInPaise:100,items:[{productId,productName:'Test',unitPriceInPaise:100,quantity:1,lineTotalInPaise:100}]};
const settings=() => ({url,namespace:ns,queues:testSpecs.map(s=>s.name),retryDelays:[100,150,200],reconnectBaseMs:80,reconnectMaxMs:1000,confirmTimeoutMs:3000,shutdownTimeoutMs:1000});
const manager=() => {const m=new Messaging(settings(),['orders','inventory','payments'],() => {});managers.push(m);return m;};
const ready=async (m:Messaging) => {m.start();await vi.waitFor(() => expect(m.status,JSON.stringify({status:m.status,counters:m.counters})).toBe('ready'),{timeout:30000,interval:50});};
const create=() => new OrderRepository(orders.pool).create(userId,randomUUID(),'fingerprint',snapshot);
const row=async () => (await orders.pool.query('SELECT * FROM outbox_events')).rows[0];
async function crash(mode:string,db:typeof orders,extra:Record<string,string>={}){
 const child=fork(new URL('./crash-process.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,TEST_POOL:JSON.stringify({...db.config,options:`-c search_path=${db.schema}`}),TEST_CRASH_MODE:mode,TEST_MESSAGING:JSON.stringify(settings()),...extra},stdio:['ignore','ignore','ignore','ipc']});children.push(child);
 const death=new Promise<void>((resolve) => child.once('exit',() => resolve()));
 if(mode.startsWith('consumer'))await new Promise<void>((resolve,reject) => {child.once('message',() => resolve());child.once('error',reject);setTimeout(() => reject(new Error('Consumer startup timeout')),30000).unref();});
 return {child,death};
}
const effect=async (client:import('pg').PoolClient,event:Event) => {await client.query('INSERT INTO test_effects(event_id) VALUES ($1)',[event.eventId]);};
const effects=async () => (await inventory.pool.query('SELECT * FROM test_effects')).rowCount;
beforeAll(async () => {orders=await isolated('orders');inventory=await isolated('inventory');payments=await isolated('payments');await inventory.pool.query('CREATE TABLE test_effects(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),event_id UUID NOT NULL)');connection=await amqp.connect(url);connection.on('error',() => {});});
beforeEach(async () => {ns=`test_${randomUUID().replaceAll('-','')}`;raw=await connection.createConfirmChannel();raw.on('error',() => {});await orders.pool.query('TRUNCATE orders CASCADE');await inventory.pool.query('TRUNCATE inbox_events,test_effects');await payments.pool.query('TRUNCATE inbox_events');});
afterEach(async () => {for(const child of children.splice(0))if(child.exitCode===null&&child.signalCode===null){const died=new Promise<void>((resolve) => child.once('exit',() => resolve()));child.kill('SIGKILL');await died;}await Promise.all(workers.splice(0).map((w) => w.stop()));await Promise.all(managers.splice(0).map((m) => m.stop()));
 for(const spec of testSpecs){const n=names(ns,spec);for(const q of [n.queue,n.dlq,...[1,2,3].map((i) => `${n.queue}.retry.${i}`)]){const ch=await connection.createChannel();ch.on('error',() => {});try{await ch.deleteQueue(q);}finally{await ch.close().catch(() => {});}}}
 for(const owner of ['orders','inventory','payments']){const ch=await connection.createChannel();ch.on('error',() => {});try{await ch.deleteExchange(`${ns}.commerce.${owner}.handoff`);}finally{await ch.close().catch(() => {});}}await raw.deleteExchange(`${ns}.commerce.events`);await raw.close();
});
afterAll(async () => {await connection?.close();await Promise.all([orders?.close(),inventory?.close(),payments?.close()]);});
describe('Real PostgreSQL + RabbitMQ outbox/inbox',() => {
 it('publishes the persisted Orders envelope into Inventory and Payments receipt-only inboxes',async () => {
  const i=receiptHandlers(inventory.pool,'inventory',{INBOX_ENABLED:'true',MESSAGING_ENABLED:'true'}),p=receiptHandlers(payments.pool,'payments',{INBOX_ENABLED:'true',MESSAGING_ENABLED:'true'});const m=manager();m.register('inventory.order-created.v1',i['inventory.order-created.v1']!);m.register('payments.order-created.v1',p['payments.order-created.v1']!);await ready(m);const created=await create(),stored=await row();const worker=new OutboxWorker(new OutboxRepository(orders.pool),m,{},() => {});workers.push(worker);await worker.runOnce();await vi.waitFor(async () => {expect((await inventory.pool.query('SELECT * FROM inbox_events')).rowCount).toBe(1);expect((await payments.pool.query('SELECT * FROM inbox_events')).rowCount).toBe(1);},{timeout:10000});expect((await row()).status).toBe('PUBLISHED');await m.publish(stored.envelope);await vi.waitFor(() => expect(m.counters.consumed).toBe(4),{timeout:10000});expect((await inventory.pool.query('SELECT * FROM inventory')).rowCount).toBe(0);expect((await payments.pool.query('SELECT * FROM payments')).rowCount).toBe(0);expect((await payments.pool.query('SELECT * FROM payment_attempts')).rowCount).toBe(0);expect(stored.envelope.payload.orderId).toBe(created.id);
 });
 it('recovers a real order-creator crash before COMMIT without orphan records',async () => {
  const orderId=randomUUID(),event=createEvent('order.created',{orderId,userId,totalAmountPaise:100,currency:'INR',items:[{productId,quantity:1}],createdAt:new Date().toISOString()});const crashed=await crash('order-before-commit',orders,{TEST_ORDER_ID:orderId,TEST_USER_ID:userId,TEST_EVENT:JSON.stringify(event)});await crashed.death;expect(crashed.child.signalCode).toBe('SIGKILL');await vi.waitFor(async () => expect((await orders.pool.query('SELECT * FROM orders')).rowCount).toBe(0));expect((await orders.pool.query('SELECT * FROM outbox_events')).rowCount).toBe(0);
 });
 it('recovers an order committed before its creator crashes and before any publication',async () => {
  const crashed=await crash('order-after-commit',orders,{TEST_USER_ID:userId,TEST_KEY:randomUUID(),TEST_SNAPSHOT:JSON.stringify(snapshot)});await crashed.death;expect(crashed.child.signalCode).toBe('SIGKILL');const stored=await row();expect(stored.status).toBe('PENDING');expect((await orders.pool.query('SELECT * FROM orders')).rowCount).toBe(1);const inbox=new InboxProcessor(inventory.pool,() => {}),m=manager();m.register('inventory.order-created.v1',async (e,c) => {await inbox.process('inventory.order-created.v1',e,effect,c.signal);});await ready(m);await new OutboxWorker(new OutboxRepository(orders.pool),m,{},() => {}).runOnce();await vi.waitFor(async () => expect(await effects()).toBe(1),{timeout:10000});expect((await row()).id).toBe(stored.id);
 });
 it('replays a publisher killed after confirm, while the inbox commits one effect',async () => {
  const inbox=new InboxProcessor(inventory.pool,() => {}),m=manager();m.register('inventory.order-created.v1',async (e,c) => {await inbox.process('inventory.order-created.v1',e,effect,c.signal);});await ready(m);await create();const stored=await row();const crashed=await crash('publisher-after-confirm',orders);await crashed.death;expect(crashed.child.signalCode).toBe('SIGKILL');await vi.waitFor(async () => expect(await effects()).toBe(1),{timeout:10000});expect((await row()).status).toBe('PROCESSING');await orders.pool.query("UPDATE outbox_events SET locked_until=clock_timestamp()-INTERVAL '1 second'");await new OutboxWorker(new OutboxRepository(orders.pool),m,{},() => {}).runOnce();await vi.waitFor(() => expect(inbox.counters.duplicates).toBe(1),{timeout:10000});expect(await effects()).toBe(1);expect((await row()).id).toBe(stored.id);expect((await row()).status).toBe('PUBLISHED');
 });
 it.each(['consumer-before-commit','consumer-after-commit'])('recovers %s with one committed effect',async (mode) => {
  // Publisher declares all namespaces; child is the only initial Inventory consumer.
  const publisher=manager();await ready(publisher);await create();const stored=await row();const crashed=await crash(mode,inventory);await publisher.publish(stored.envelope);await crashed.death;expect(crashed.child.signalCode).toBe('SIGKILL');await vi.waitFor(async () => expect(await effects()).toBe(mode==='consumer-before-commit'?0:1),{timeout:10000});const inbox=new InboxProcessor(inventory.pool,() => {}),recover=manager();recover.register('inventory.order-created.v1',async (e,c) => {await inbox.process('inventory.order-created.v1',e,effect,c.signal);});await ready(recover);await vi.waitFor(() => expect(recover.counters.consumed).toBe(1),{timeout:10000});expect(await effects()).toBe(1);expect((await inventory.pool.query('SELECT * FROM inbox_events')).rowCount).toBe(1);expect(inbox.counters.duplicates).toBe(mode==='consumer-after-commit'?1:0);
 });
 it('tolerates a stale worker publishing after lease takeover without repeating committed effects',async () => {
  const inbox=new InboxProcessor(inventory.pool,() => {}),m=manager();m.register('inventory.order-created.v1',async (e,c) => {await inbox.process('inventory.order-created.v1',e,effect,c.signal);});await ready(m);await create();const original=await row();let resume=() => {};const paused=new Promise<void>((resolve) => {resume=resolve;});
  const first=new OutboxWorker(new OutboxRepository(orders.pool),{publish:async (event) => {await paused;await m.publish(event);}},{},() => {});workers.push(first);const inFlight=first.runOnce();await vi.waitFor(async () => expect((await row()).status).toBe('PROCESSING'),{timeout:10000});const token=(await row()).claim_token;
  await orders.pool.query("UPDATE outbox_events SET locked_until=clock_timestamp()-INTERVAL '1 second'");const second=new OutboxWorker(new OutboxRepository(orders.pool),m,{},() => {});await second.runOnce();expect((await row()).status).toBe('PUBLISHED');resume();await inFlight;
  await vi.waitFor(() => expect(inbox.counters.duplicates).toBe(1),{timeout:10000});expect(await effects()).toBe(1);expect((await row()).id).toBe(original.id);expect((await row()).status).toBe('PUBLISHED');expect((await row()).claim_token).not.toBe(token);expect((await row()).attempts).toBe(2);
 });
 it('lets RabbitMQ retries recover a failed inbox transaction without duplicate effects',async () => {
  let attempts=0;const inbox=new InboxProcessor(inventory.pool,() => {}),m=manager();m.register('inventory.order-created.v1',async (e,c) => {await inbox.process('inventory.order-created.v1',e,async (client,event) => {await effect(client,event);if(attempts++===0)throw new Error('retry');},c.signal);});await ready(m);await create();await new OutboxWorker(new OutboxRepository(orders.pool),m,{},() => {}).runOnce();await vi.waitFor(() => expect(m.counters.consumed).toBe(1),{timeout:10000});expect(attempts).toBe(2);expect(await effects()).toBe(1);expect((await inventory.pool.query('SELECT * FROM inbox_events')).rowCount).toBe(1);
 });
 it('preserves committed events while RabbitMQ is unavailable and publishes after recovery',async () => {
  const offline=new Messaging({...settings(),url:'amqp://unavailable:password@127.0.0.1:1/commerce_test'},['orders'],() => {});managers.push(offline);offline.start();await create();const stored=await row();await new OutboxWorker(new OutboxRepository(orders.pool),offline,{},() => {},Date.now,() => 0).runOnce();expect((await row()).status).toBe('PENDING');const m=manager();await ready(m);await new OutboxWorker(new OutboxRepository(orders.pool),m,{},() => {}).runOnce();expect((await row()).status).toBe('PUBLISHED');const message=await raw.get(names(ns,testSpecs[0]!).queue,{noAck:false});expect(message).not.toBe(false);if(message){expect(JSON.parse(message.content.toString()).eventId).toBe(stored.id);raw.ack(message);}
 });
});
