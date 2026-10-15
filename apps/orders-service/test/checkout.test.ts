import {testEnvironmentFile} from '../../../test/environment.js';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {fork,type ChildProcess} from 'node:child_process';
import {Pool} from 'pg';
import amqp from 'amqplib';
import request from 'supertest';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {Messaging,sagaEvent,authorizeSaga,queueSpecs,names,type Event,type SagaKeys} from '@ecommerce/messaging';
import {OutboxRepository,OutboxWorker} from '@ecommerce/event-persistence';
import {isolated} from '../../../packages/event-persistence/test/setup.js';
import {createJwtFixture} from '../../../test/jwt-fixture.js';
import {OrderRepository} from '../src/order-repository.js';
import {OrderService} from '../src/order-service.js';
import {CartClient,CatalogClient} from '../src/http-clients.js';
import {createApp} from '../src/app.js';
import {createApp as gatewayApp} from '../../api-gateway/src/app.js';
import {SagaRepository,link,type SagaRow} from '../src/saga/repository.js';
import {inventoryCheckoutHandler} from '../../inventory-service/src/checkout-consumer.js';
import {InventoryRepository} from '../../inventory-service/src/inventory-repository.js';
import {paymentsCheckoutHandler,processCheckoutPayments} from '../../payments-service/src/checkout-consumer.js';
import {PaymentRepository} from '../../payments-service/src/payment-repository.js';
import {PaymentService} from '../../payments-service/src/payment-service.js';
import {ProviderClient} from '../../payments-service/src/provider-client.js';
import {createMockProvider,type Scenario} from '../../payments-service/src/mock-provider/app.js';
vi.setConfig({testTimeout:30000,hookTimeout:60000});
const keys:SagaKeys={'orders-service':'o'.repeat(32),'inventory-service':'i'.repeat(32),'payments-service':'p'.repeat(32)};
const context={retryCount:0,redelivered:false,signal:new AbortController().signal};
const userId=randomUUID(),productId=randomUUID();
const snapshot={totalAmountInPaise:125,items:[{productId,productName:'Authoritative',unitPriceInPaise:125,quantity:1,lineTotalInPaise:125}]};
let orders:Awaited<ReturnType<typeof isolated>>,inventory:typeof orders,payments:typeof orders;
let mockAdmin:Pool,mockPool:Pool,mockSchema:string,scenario:Scenario='success',provider:Server,catalog:Server;
let providerUrl:string,catalogUrl:string,saga:SagaRepository,stock:InventoryRepository,paymentRepo:PaymentRepository,paymentService:PaymentService;
let inventoryHandler:ReturnType<typeof inventoryCheckoutHandler>,paymentHandler:ReturnType<typeof paymentsCheckoutHandler>;
const children:ChildProcess[]=[];const servers:Server[]=[];
const jwt=await createJwtFixture();const token=`Bearer ${await jwt.sign('customer',{sub:userId})}`;
const env=parseEnv(await readFile(testEnvironmentFile('.env.messaging'),'utf8'));
const rabbitUrl=`amqp://commerce_test:${encodeURIComponent(env.RABBITMQ_TEST_PASSWORD!)}@127.0.0.1:${env.RABBITMQ_AMQP_PORT??5673}/commerce_test`;
const row=async(id?:string)=>(await orders.pool.query<SagaRow>('SELECT * FROM checkout_sagas WHERE ($1::uuid IS NULL OR order_id=$1) ORDER BY created_at DESC',[id??null])).rows[0]!;
const events=async(db:typeof orders,type?:string)=>(await db.pool.query<{envelope:Event}>("SELECT envelope FROM outbox_events WHERE ($1::text IS NULL OR event_type=$1) ORDER BY created_at,id",[type??null])).rows.map(r=>r.envelope);
const command=async(type:string)=>(await events(orders,type)).at(-1)!;
async function create(key=randomUUID()){return new OrderRepository(orders.pool).create(userId,key,'snapshot',snapshot,keys);}
async function reserve(){await inventoryHandler(await command('inventory.reserve.requested'),context);await saga.handler((await events(inventory,'checkout.inventory.reserved')).at(-1)!,context);}
async function pay(){await paymentHandler(await command('payment.process.requested'),context);await processCheckoutPayments(payments.pool,paymentService,keys);for(const event of await events(payments))await saga.handler(event,context);}
async function finish(){await inventoryHandler(await command('inventory.confirm.requested'),context);await saga.handler((await events(inventory,'checkout.inventory.confirmed')).at(-1)!,context);}
async function release(){await inventoryHandler(await command('inventory.release.requested'),context);await saga.handler((await events(inventory,'checkout.inventory.released')).at(-1)!,context);}
const charges=async()=>(await mockPool.query('SELECT * FROM mock_charges')).rows;
const app=()=>createApp(new OrderService(new OrderRepository(orders.pool),new CartClient(catalogUrl,1000),new CatalogClient(catalogUrl,1000)),jwt.verify,()=> 'ready',{repository:saga,keys});
async function crash(mode:string,db:typeof orders,extra:Record<string,string>={}){
 const child=fork(new URL('./checkout-crash.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,TEST_POOL:JSON.stringify({...db.config,options:`-c search_path=${db.schema}`}),TEST_MODE:mode,TEST_KEYS:JSON.stringify(keys),TEST_USER:userId,TEST_SNAPSHOT:JSON.stringify(snapshot),TEST_PROVIDER:providerUrl,...extra},stdio:['ignore','ignore','pipe','ipc']});children.push(child);let diagnostic='';child.stderr?.on('data',chunk=>{diagnostic+=chunk.toString();});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Crash fixture timed out'));},10000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);resolve();});});expect(child.signalCode,diagnostic).toBe('SIGKILL');
}
beforeAll(async()=>{
 orders=await isolated('orders');inventory=await isolated('inventory');payments=await isolated('payments');
 const e=parseEnv(await readFile(testEnvironmentFile('.env.mock-provider'),'utf8'));
 const config={host:e.MOCK_PGHOST??'127.0.0.1',port:Number(e.MOCK_PGPORT??5432),database:'mock_provider_test_db',user:'mock_provider_test_user',password:e.MOCK_TEST_PASSWORD,max:3,connectionTimeoutMillis:5000};
 mockAdmin=new Pool(config);expect((await mockAdmin.query('SELECT current_database() AS db')).rows[0].db).toBe('mock_provider_test_db');mockSchema=`test_${randomUUID().replaceAll('-','')}`;await mockAdmin.query(`CREATE SCHEMA "${mockSchema}"`);mockPool=new Pool({...config,options:`-c search_path=${mockSchema}`});await mockPool.query(await readFile(new URL('../../payments-service/src/mock-provider/schema.sql',import.meta.url),'utf8'));
 provider=createServer(createMockProvider(mockPool,()=>scenario,100));await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));providerUrl=`http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
 catalog=createServer((req,res)=>res.setHeader('content-type','application/json').end(JSON.stringify(req.url==='/cart'?{items:[{productId,quantity:1}]}:{id:productId,name:'Authoritative',priceInPaise:125})));await new Promise<void>(r=>catalog.listen(0,'127.0.0.1',r));catalogUrl=`http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
});
beforeEach(async()=>{
 await orders.pool.query('TRUNCATE orders,outbox_events,inbox_events CASCADE');await inventory.pool.query('TRUNCATE inventory,inventory_reservation_requests,inbox_events,outbox_events CASCADE');await payments.pool.query('TRUNCATE payments,inbox_events,outbox_events CASCADE');await mockPool.query('TRUNCATE mock_charges');
 scenario='success';saga=new SagaRepository(orders.pool,keys);stock=new InventoryRepository(inventory.pool,1);paymentRepo=new PaymentRepository(payments.pool,100,10,keys);paymentService=new PaymentService(paymentRepo,new ProviderClient(providerUrl,1000));inventoryHandler=inventoryCheckoutHandler(inventory.pool,stock,keys);paymentHandler=paymentsCheckoutHandler(payments.pool,paymentRepo,keys);await stock.put(productId,5);
});
afterEach(async()=>{for(const c of children.splice(0))if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>{s.close(()=>r());s.closeAllConnections();})));vi.restoreAllMocks();});
afterAll(async()=>{await Promise.all([provider,catalog].filter(Boolean).map(s=>new Promise<void>(r=>{s.close(()=>r());s.closeAllConnections();})));await mockPool?.end();if(mockSchema)await mockAdmin.query(`DROP SCHEMA "${mockSchema}" CASCADE`);await mockAdmin?.end();await Promise.all([orders?.close(),inventory?.close(),payments?.close()]);});
describe('Durable checkout with real service databases and provider',()=>{
 it('completes only after inventory confirmation with an immutable audit trail',async()=>{const o=await create();await reserve();await pay();expect((await row()).state).toBe('INVENTORY_CONFIRMATION_PENDING');expect((await new OrderRepository(orders.pool).findById(userId,o.id))?.status).toBe('PENDING');await finish();expect((await row()).state).toBe('COMPLETED');expect((await new OrderRepository(orders.pool).findById(userId,o.id))?.status).toBe('CONFIRMED');expect(await stock.find(productId)).toMatchObject({totalStock:4,reservedStock:0});expect((await orders.pool.query('SELECT to_state FROM checkout_saga_transitions ORDER BY sequence')).rows.map(r=>r.to_state)).toEqual(['CREATED','INVENTORY_PENDING','INVENTORY_RESERVED','PAYMENT_PENDING','PAYMENT_SUCCEEDED','INVENTORY_CONFIRMATION_PENDING','COMPLETED']);});
 it('never attempts payment when inventory is insufficient',async()=>{await stock.put(productId,0);await create();await inventoryHandler(await command('inventory.reserve.requested'),context);await saga.handler((await events(inventory,'checkout.inventory.reservation_failed'))[0]!,context);expect((await row()).state).toBe('FAILED');expect(await events(orders,'payment.process.requested')).toHaveLength(0);expect(await charges()).toHaveLength(0);});
 it('compensates a definitive decline after release commits',async()=>{scenario='decline';await create();await reserve();await pay();expect((await row()).state).toBe('COMPENSATION_PENDING');expect(await stock.find(productId)).toMatchObject({reservedStock:1});await release();expect((await row()).state).toBe('COMPENSATED');expect(await stock.find(productId)).toMatchObject({totalStock:5,reservedStock:0});});
 it('protects lost-response payments, reconciles with the original key and never charges twice',async()=>{scenario='lost-response';await create();await reserve();await pay();expect((await row()).state).toBe('PAYMENT_RECONCILIATION_REQUIRED');const id=(await row()).order_id;await inventory.pool.query("UPDATE inventory_reservations SET expires_at=clock_timestamp()-INTERVAL '1 hour'");expect(await stock.expireBatch()).toBe(0);await paymentHandler({...await command('payment.process.requested'),eventId:randomUUID()} as Event,context).catch(()=>{});await payments.pool.query('UPDATE payments SET next_reconcile_at=clock_timestamp()');expect(await paymentService.reconcileBatch(10)).toBe(1);for(const e of await events(payments))await saga.handler(e,context);await finish();expect((await row(id)).state).toBe('COMPLETED');expect(await charges()).toHaveLength(1);expect((await payments.pool.query('SELECT provider_request_id FROM payment_attempts')).rows[0].provider_request_id).toBe((await row()).payment_id);});
 it('keeps a genuinely unknown provider result unresolved without releasing stock',async()=>{scenario='ambiguous';await create();await reserve();await pay();await paymentService.reconcileBatch(10);for(const e of await events(payments))await saga.handler(e,context);expect((await row()).state).toBe('PAYMENT_RECONCILIATION_REQUIRED');expect(await events(orders,'inventory.release.requested')).toHaveLength(0);expect(await charges()).toHaveLength(1);});
 it('deduplicates concurrent checkout requests and every delivered step',async()=>{const key=randomUUID();const created=await Promise.all(Array.from({length:8},()=>create(key)));expect(new Set(created.map(o=>o.id)).size).toBe(1);const cmd=await command('inventory.reserve.requested');await Promise.all([inventoryHandler(cmd,context),inventoryHandler(cmd,context)]);const e=(await events(inventory,'checkout.inventory.reserved'))[0]!;await Promise.all([saga.handler(e,context),saga.handler(e,context)]);const pc=await command('payment.process.requested');await Promise.all([paymentHandler(pc,context),paymentHandler(pc,context)]);await Promise.all([processCheckoutPayments(payments.pool,paymentService,keys),processCheckoutPayments(payments.pool,paymentService,keys)]);const success=(await events(payments,'checkout.payment.succeeded'))[0]!;await Promise.all([saga.handler(success,context),saga.handler(success,context)]);await finish();expect(await charges()).toHaveLength(1);expect(await events(orders,'payment.process.requested')).toHaveLength(1);});
 it('ignores stale failure, duplicate inventory success, and out-of-order confirmation',async()=>{await create();const s=await row();const payload={...link(s),reservationId:s.reservation_operation_id};await saga.handler(sagaEvent('checkout.inventory.confirmed',payload,keys,s.correlation_id),context);expect((await row()).state).toBe('INVENTORY_PENDING');await reserve();await pay();await finish();await saga.handler(sagaEvent('checkout.payment.failed',{...payload,paymentId:(await row()).payment_id!},keys,s.correlation_id),context);await saga.handler(sagaEvent('checkout.inventory.reserved',payload,keys,s.correlation_id),context);expect((await row()).state).toBe('COMPLETED');expect(await events(orders,'inventory.release.requested')).toHaveLength(0);});
 it('rejects wrong operations and signatures without committing inbox records',async()=>{await create();const cmd=await command('inventory.reserve.requested');expect(()=>authorizeSaga({...cmd,signature:undefined},keys)).toThrow();expect(()=>authorizeSaga({...cmd,payload:{...cmd.payload,orderId:randomUUID()}} as Event,keys)).toThrow();const s=await row();await expect(saga.handler(sagaEvent('checkout.inventory.reserved',{...link(s),reservationId:randomUUID()},keys,s.correlation_id),context)).rejects.toThrow();expect((await orders.pool.query('SELECT * FROM inbox_events')).rowCount).toBe(0);});
 it('prevents unrelated Sagas from changing a held reservation and blocks HTTP repository finish',async()=>{await create();await reserve();const s=await row();await expect(stock.finish(s.order_id,'RELEASED')).rejects.toThrow();await expect(inventoryHandler(sagaEvent('inventory.release.requested',{...link(s),sagaId:randomUUID(),reservationId:s.reservation_operation_id},keys,s.correlation_id),context)).rejects.toThrow();expect(await stock.find(productId)).toMatchObject({reservedStock:1});});
 it('serializes concurrent checkouts against the last unit',async()=>{await stock.put(productId,1);await Promise.all([create(),create()]);await Promise.all((await events(orders,'inventory.reserve.requested')).map(e=>inventoryHandler(e,context)));for(const e of await events(inventory))await saga.handler(e,context);expect(await events(orders,'payment.process.requested')).toHaveLength(1);expect((await orders.pool.query("SELECT * FROM checkout_sagas WHERE state='FAILED'")).rowCount).toBe(1);expect(await stock.find(productId)).toMatchObject({reservedStock:1,availableStock:0});});
 it('rolls back inventory, inbox and response outbox together then redelivery recovers',async()=>{await create();const cmd=await command('inventory.reserve.requested');const failing=inventoryCheckoutHandler(inventory.pool,stock,keys,async p=>{if(p==='before_commit')throw new Error('Injected rollback');});await expect(failing(cmd,context)).rejects.toThrow();expect(await stock.find(productId)).toMatchObject({reservedStock:0});expect(await events(inventory)).toHaveLength(0);expect((await inventory.pool.query('SELECT * FROM inbox_events')).rowCount).toBe(0);await inventoryHandler(cmd,context);expect(await stock.find(productId)).toMatchObject({reservedStock:1});});
 it('replays a committed reservation after a consumer dies before ACK',async()=>{await create();const cmd=await command('inventory.reserve.requested');await crash('inventory-after-commit',inventory,{TEST_EVENT:JSON.stringify(cmd)});await inventoryHandler(cmd,context);expect(await stock.find(productId)).toMatchObject({reservedStock:1});expect(await events(inventory,'checkout.inventory.reserved')).toHaveLength(1);});
 it('recovers an inventory consumer crash before commit with no orphan effects',async()=>{await create();const cmd=await command('inventory.reserve.requested');await crash('inventory-before-commit',inventory,{TEST_EVENT:JSON.stringify(cmd)});expect(await stock.find(productId)).toMatchObject({reservedStock:0});await inventoryHandler(cmd,context);expect(await stock.find(productId)).toMatchObject({reservedStock:1});});
 it('recovers a provider-success worker crash by lookup, without another charge',async()=>{await create();await reserve();await paymentHandler(await command('payment.process.requested'),context);const id=(await payments.pool.query('SELECT id FROM payments')).rows[0].id;await crash('payment-after-charge',payments,{TEST_PAYMENT:id});await payments.pool.query("UPDATE payments SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'");await processCheckoutPayments(payments.pool,paymentService,keys);for(const e of await events(payments))await saga.handler(e,context);await finish();expect((await row()).state).toBe('COMPLETED');expect(await charges()).toHaveLength(1);});
 it('recovers creation committed before an Orders process dies',async()=>{await crash('order-after-commit',orders);expect((await row()).state).toBe('INVENTORY_PENDING');expect(await events(orders,'inventory.reserve.requested')).toHaveLength(1);await reserve();await pay();await finish();expect((await row()).state).toBe('COMPLETED');});
 it('recovers expired Saga claims and fences a stale recovery worker',async()=>{await create();await orders.pool.query('UPDATE checkout_sagas SET next_action_at=clock_timestamp()');await crash('saga-after-claim',orders);await orders.pool.query("UPDATE checkout_sagas SET locked_until=clock_timestamp()-INTERVAL '1 second'");await Promise.all([saga.recover(),saga.recover()]);expect(await events(orders,'inventory.reserve.requested')).toHaveLength(2);const commands=await events(orders,'inventory.reserve.requested');expect(commands[0]!.payload).toEqual(commands[1]!.payload);expect((await row()).claim_token).toBeNull();});
 it('rolls back a recovery outbox insertion and resumes after lease expiration',async()=>{await create();await orders.pool.query('UPDATE checkout_sagas SET next_action_at=clock_timestamp()');await crash('saga-before-commit',orders);expect(await events(orders,'inventory.reserve.requested')).toHaveLength(1);await orders.pool.query("UPDATE checkout_sagas SET locked_until=clock_timestamp()-INTERVAL '1 second'");await saga.recover();expect(await events(orders,'inventory.reserve.requested')).toHaveLength(2);});
 it('recovers compensation after a committed release crashes before acknowledgment',async()=>{scenario='decline';await create();await reserve();await pay();const cmd=await command('inventory.release.requested');await crash('inventory-after-commit',inventory,{TEST_EVENT:JSON.stringify(cmd)});expect((await row()).state).toBe('COMPENSATION_PENDING');await release();expect((await row()).state).toBe('COMPENSATED');expect(await stock.find(productId)).toMatchObject({reservedStock:0,totalStock:5});});
 it('escalates paid but unfulfillable reservations without releasing stock or failing the order',async()=>{await create();await reserve();await pay();const s=await row();await saga.handler(sagaEvent('checkout.inventory.confirmation_failed',{...link(s),reservationId:s.reservation_operation_id,reason:'INVALID_RESERVATION'},keys,s.correlation_id),context);expect((await row()).state).toBe('MANUAL_REVIEW_REQUIRED');expect((await orders.pool.query('SELECT status FROM orders')).rows[0].status).toBe('PENDING');expect(await events(orders,'inventory.release.requested')).toHaveLength(0);});
 it('stops automated recovery at its retry bound without assuming unknown payment failure',async()=>{scenario='ambiguous';await create();await reserve();await pay();for(let i=0;i<8;i++){await orders.pool.query('UPDATE checkout_sagas SET next_action_at=clock_timestamp()');await saga.recover();}const persisted=(await orders.pool.query('SELECT * FROM checkout_sagas')).rows[0];expect(persisted.state).toBe('PAYMENT_RECONCILIATION_REQUIRED');expect(persisted.next_action_at).toBeNull();expect(persisted.last_error).toContain('RECOVERY_EXHAUSTED');expect(await events(orders,'inventory.release.requested')).toHaveLength(0);});
 it('rolls back order, items, Saga, audit and both outboxes when initial command persistence fails',async()=>{
  await orders.pool.query(`CREATE FUNCTION fail_initial_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='inventory.reserve.requested' THEN RAISE EXCEPTION 'Injected initial outbox rollback'; END IF; RETURN NEW; END $$`);
  await orders.pool.query('CREATE TRIGGER fail_initial_command BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_initial_command()');
  try {await expect(create()).rejects.toThrow();for(const table of ['orders','order_items','checkout_sagas','checkout_saga_transitions','outbox_events'])expect((await orders.pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);}
  finally {await orders.pool.query('DROP TRIGGER fail_initial_command ON outbox_events');await orders.pool.query('DROP FUNCTION fail_initial_command()');}
 });
 it('keeps compensation pending when its local transaction rolls back and releases on retry',async()=>{
  scenario='decline';await create();await reserve();await pay();
  const failing=inventoryCheckoutHandler(inventory.pool,stock,keys,async point=>{if(point==='before_commit')throw new Error('Injected compensation rollback');});
  await expect(failing(await command('inventory.release.requested'),context)).rejects.toThrow();
  expect((await row()).state).toBe('COMPENSATION_PENDING');expect(await stock.find(productId)).toMatchObject({reservedStock:1});expect(await events(inventory,'checkout.inventory.released')).toHaveLength(0);
  await release();expect((await row()).state).toBe('COMPENSATED');
 });
 it('republishes a definitive payment outcome on transport retry without repeating provider work',async()=>{
  await create();await reserve();await pay();const original=await command('payment.process.requested');
  await paymentHandler(sagaEvent(original.eventType,original.payload as never,keys,original.correlationId,original),context);
  await processCheckoutPayments(payments.pool,paymentService,keys);
  expect(await events(payments,'checkout.payment.succeeded')).toHaveLength(2);expect(await charges()).toHaveLength(1);
 });
 it('classifies unknown Saga outcomes without creating a Saga',async()=>{
  const payload={sagaId:randomUUID(),orderId:randomUUID(),userId,reservationOperationId:randomUUID(),paymentOperationId:randomUUID(),reservationId:randomUUID()};
  await saga.handler(sagaEvent('checkout.inventory.reserved',payload,keys,randomUUID()),context);
  expect((await orders.pool.query('SELECT * FROM checkout_sagas')).rowCount).toBe(0);expect((await orders.pool.query('SELECT * FROM inbox_events')).rowCount).toBe(1);
 });
 it('serves authenticated 202 checkout with authoritative totals, ownership and restricted retries',async()=>{const api=app();await request(api).post('/checkout').send({}).expect(401);await request(api).post('/checkout').set('authorization',token).set('idempotency-key','bad-price').send({price:1,userId:randomUUID()}).expect(400);const started=await request(api).post('/checkout').set('authorization',token).set('idempotency-key','api-checkout').send({}).expect(202);expect(started.body.status).toBe('INVENTORY_PENDING');const id=started.body.orderId;await request(api).get(`/checkout/${id}/status`).set('authorization',token).expect(200);const other=`Bearer ${await jwt.sign('customer',{sub:randomUUID()})}`;await request(api).get(`/checkout/${id}/status`).set('authorization',other).expect(404);await request(api).post(`/checkout/${id}/retry`).set('authorization',other).send({}).expect(404);await request(api).post(`/checkout/${id}/retry`).set('authorization',token).send({}).expect(202);await reserve();await request(api).post(`/checkout/${id}/retry`).set('authorization',token).send({}).expect(409);expect((await orders.pool.query('SELECT total_amount_paise::text FROM orders')).rows[0].total_amount_paise).toBe('125');});
 it('preserves legacy order creation and rejects converting its idempotency replay into a checkout',async()=>{const api=app();await request(api).post('/orders').set('authorization',token).set('idempotency-key','legacy').send({}).expect(201);await request(api).post('/checkout').set('authorization',token).set('idempotency-key','legacy').send({}).expect(409);expect((await orders.pool.query('SELECT * FROM checkout_sagas')).rowCount).toBe(0);});
 it('forwards checkout through Gateway including asynchronous status and authorization',async()=>{const server=createServer(app());servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;const gateway=gatewayApp({CATALOG_SERVICE_URL:catalogUrl,CATALOG_REQUEST_TIMEOUT_MS:1000,ORDERS_SERVICE_URL:origin});const res=await request(gateway).post('/checkout').set('authorization',token).set('idempotency-key','gateway').send({}).expect(202);await request(gateway).get(`/checkout/${res.body.orderId}/status`).set('authorization',token).expect(200);await request(gateway).post(`/checkout/${res.body.orderId}/retry`).set('authorization',token).send({}).expect(202);});
});
describe('Real RabbitMQ checkout delivery and outage recovery',()=>{
 it('completes checkout over RabbitMQ with duplicate deliveries and committed outbox restart recovery',async()=>{
  const ns=`test_${randomUUID().replaceAll('-','')}`;
  const selected=['inventory.order-created.v1','payments.order-created.v1','inventory.checkout-commands.v1','payments.checkout-commands.v1','orders.checkout-events.v1'] as const;
  const settings={url:rabbitUrl,namespace:ns,queues:[...selected],retryDelays:[100,150,200],reconnectBaseMs:50,reconnectMaxMs:500,confirmTimeoutMs:2000,shutdownTimeoutMs:1000};
  const manager=new Messaging(settings,['orders','inventory','payments'],()=>{});
  let crashBeforeAck=true;
  const ackCrashHandler=inventoryCheckoutHandler(inventory.pool,stock,keys,async point=>{if(point==='after_commit'&&crashBeforeAck){crashBeforeAck=false;throw new Error('Injected broker ACK window');}});
  manager.register('inventory.checkout-commands.v1',ackCrashHandler);manager.register('payments.checkout-commands.v1',paymentHandler);manager.register('orders.checkout-events.v1',saga.handler);
  const workers=[orders,inventory,payments].map(db=>new OutboxWorker(new OutboxRepository(db.pool),manager,{},()=>{},Date.now,()=>0));
  const offline=new Messaging({...settings,url:'amqp://unavailable:password@127.0.0.1:1/commerce_test'},['orders'],()=>{});
  let connection:Awaited<ReturnType<typeof amqp.connect>>|undefined;
  try {
   const order=await create();offline.start();await new OutboxWorker(new OutboxRepository(orders.pool),offline,{},()=>{},Date.now,()=>0).runOnce();
   expect((await orders.pool.query("SELECT status FROM outbox_events WHERE event_type='inventory.reserve.requested'")).rows[0].status).toBe('PENDING');
   manager.start();await vi.waitFor(()=>expect(manager.status,JSON.stringify({status:manager.status,counters:manager.counters})).toBe('ready'),{timeout:20000});
   await vi.waitFor(async()=>{for(const worker of workers)await worker.runOnce();await processCheckoutPayments(payments.pool,paymentService,keys);expect((await row(order.id)).state).toBe('COMPLETED');},{timeout:20000,interval:100});
   const inventoryEvent=(await events(inventory,'checkout.inventory.reserved'))[0]!;
   const paymentEvent=(await events(payments,'checkout.payment.succeeded'))[0]!;
   await manager.publish(inventoryEvent);await manager.publish(paymentEvent);await manager.publish(await command('payment.process.requested'));
   await vi.waitFor(async()=>expect((await payments.pool.query('SELECT * FROM payments')).rowCount).toBe(1));
   expect(await charges()).toHaveLength(1);expect((await row()).state).toBe('COMPLETED');
  }finally{
   await Promise.all(workers.map(w=>w.stop()));await offline.stop();await manager.stop();
   connection=await amqp.connect(rabbitUrl);const channel=await connection.createChannel();
   for(const spec of queueSpecs.filter(s=>settings.queues.some(name=>name===s.name))){const n=names(ns,spec);for(const q of [n.queue,n.dlq,...[1,2,3].map(i=>`${n.queue}.retry.${i}`)])await channel.deleteQueue(q);}
   for(const service of ['orders','inventory','payments'])await channel.deleteExchange(`${ns}.commerce.${service}.handoff`);
   await channel.deleteExchange(`${ns}.commerce.events`);await channel.close();await connection.close();
  }
 });
});
