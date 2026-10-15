import {proveGrafana} from './grafana-proof.mjs';
import {checkoutParentage,cleanupProof} from './proof-assertions.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initializeTelemetry} from '../bootstrap.mjs';
import {instrumentPg,instrumentRedis,operation,correlation} from '../src/index.js';
import {isolatedRedis} from '../../rate-limiting/test/fixture.js';
import {searchFixture} from '../../../apps/search-service/test/fixture.js';
import {writeFile} from 'node:fs/promises';
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
import {OrderRepository} from '../../../apps/orders-service/src/order-repository.js';
import {OrderService} from '../../../apps/orders-service/src/order-service.js';
import {CartClient,CatalogClient} from '../../../apps/orders-service/src/http-clients.js';
import {createApp} from '../../../apps/orders-service/src/app.js';
import {createApp as gatewayApp} from '../../../apps/api-gateway/src/app.js';
import {SagaRepository,link,type SagaRow} from '../../../apps/orders-service/src/saga/repository.js';
import {inventoryCheckoutHandler} from '../../../apps/inventory-service/src/checkout-consumer.js';
import {InventoryRepository} from '../../../apps/inventory-service/src/inventory-repository.js';
import {paymentsCheckoutHandler,processCheckoutPayments} from '../../../apps/payments-service/src/checkout-consumer.js';
import {PaymentRepository} from '../../../apps/payments-service/src/payment-repository.js';
import {PaymentService} from '../../../apps/payments-service/src/payment-service.js';
import {ProviderClient} from '../../../apps/payments-service/src/provider-client.js';
import {createMockProvider,type Scenario} from '../../../apps/payments-service/src/mock-provider/app.js';
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
let telemetry:Awaited<ReturnType<typeof initializeTelemetry>>;
beforeAll(async()=>{
 telemetry=await initializeTelemetry({...process.env,OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'observability-proof',OTEL_TRACES_SAMPLER_ARG:'1',OTEL_METRIC_EXPORT_INTERVAL:'1000'});
 orders=await isolated('orders');inventory=await isolated('inventory');payments=await isolated('payments');
 for(const db of [orders,inventory,payments])db.pool=instrumentPg(db.pool);
 const e=parseEnv(await readFile(testEnvironmentFile('.env.mock-provider'),'utf8'));
 const config={host:e.MOCK_PGHOST??'127.0.0.1',port:Number(e.MOCK_PGPORT??5432),database:'mock_provider_test_db',user:'mock_provider_test_user',password:e.MOCK_TEST_PASSWORD,max:3,connectionTimeoutMillis:5000};
 mockAdmin=new Pool(config);expect((await mockAdmin.query('SELECT current_database() AS db')).rows[0].db).toBe('mock_provider_test_db');mockSchema=`test_${randomUUID().replaceAll('-','')}`;await mockAdmin.query(`CREATE SCHEMA "${mockSchema}"`);mockPool=new Pool({...config,options:`-c search_path=${mockSchema}`});await mockPool.query(await readFile(new URL('../../../apps/payments-service/src/mock-provider/schema.sql',import.meta.url),'utf8'));
 provider=createServer(createMockProvider(mockPool,()=>scenario,100));await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));providerUrl=`http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
 catalog=createServer((req,res)=>res.setHeader('content-type','application/json').end(JSON.stringify(req.url==='/cart'?{items:[{productId,quantity:1}]}:{id:productId,name:'Authoritative',priceInPaise:125})));await new Promise<void>(r=>catalog.listen(0,'127.0.0.1',r));catalogUrl=`http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
});
beforeEach(async()=>{
 await orders.pool.query('TRUNCATE orders,outbox_events,inbox_events CASCADE');await inventory.pool.query('TRUNCATE inventory,inventory_reservation_requests,inbox_events,outbox_events CASCADE');await payments.pool.query('TRUNCATE payments,inbox_events,outbox_events CASCADE');await mockPool.query('TRUNCATE mock_charges');
 scenario='success';saga=new SagaRepository(orders.pool,keys);stock=new InventoryRepository(inventory.pool,1);paymentRepo=new PaymentRepository(payments.pool,100,10,keys);paymentService=new PaymentService(paymentRepo,new ProviderClient(providerUrl,1000));inventoryHandler=inventoryCheckoutHandler(inventory.pool,stock,keys);paymentHandler=paymentsCheckoutHandler(payments.pool,paymentRepo,keys);await stock.put(productId,5);
});
afterEach(async()=>{for(const c of children.splice(0))if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>{s.close(()=>r());s.closeAllConnections();})));vi.restoreAllMocks();});
afterAll(async()=>{await Promise.all([provider,catalog].filter(Boolean).map(s=>new Promise<void>(r=>{s.close(()=>r());s.closeAllConnections();})));await mockPool?.end();if(mockSchema)await mockAdmin.query(`DROP SCHEMA "${mockSchema}" CASCADE`);await mockAdmin?.end();await Promise.all([orders?.close(),inventory?.close(),payments?.close()]);await telemetry?.shutdown();});

async function proveFlow(outage?:'otel-collector'|'tempo'|'prometheus'|'grafana'){
 const project=process.env.OBS_BACKEND_PROJECT;if(!project||!/^commerce-v2-observability-[a-f0-9]{12}$/.test(project))throw new Error('Expected owned telemetry project');
 const control=async(action:string)=>promisify(execFile)('docker',['compose','-p',project,'-f','compose.observability.yaml','--profile','observability',action,outage!],{timeout:30000});
 if(outage)await control('stop');
 const logs:Record<string,unknown>[]=[];const original=console.info;vi.spyOn(console,'info').mockImplementation(value=>{try{logs.push(JSON.parse(String(value)));}catch{}original(value);});
 const ns=`test_${randomUUID().replaceAll('-','')}`;
 const selected=['inventory.order-created.v1','payments.order-created.v1','inventory.checkout-commands.v1','payments.checkout-commands.v1','orders.checkout-events.v1'] as const;
 const settings={url:rabbitUrl,namespace:ns,queues:[...selected],retryDelays:[100,150,200],reconnectBaseMs:50,reconnectMaxMs:500,confirmTimeoutMs:2000,shutdownTimeoutMs:1000};
 const manager=new Messaging(settings,['orders','inventory','payments']);
 let crashBeforeAck=true;const ackWindow=inventoryCheckoutHandler(inventory.pool,stock,keys,async point=>{if(point==='after_commit'&&crashBeforeAck){crashBeforeAck=false;throw new Error('Injected committed-before-ACK failure');}});
 manager.register('inventory.checkout-commands.v1',ackWindow);manager.register('payments.checkout-commands.v1',paymentHandler);manager.register('orders.checkout-events.v1',saga.handler);
 const workers=[orders,inventory,payments].map(db=>new OutboxWorker(new OutboxRepository(db.pool),manager,{},()=>{},Date.now,()=>0));
 let f:Awaited<ReturnType<typeof searchFixture>>|undefined,redis:Awaited<ReturnType<typeof isolatedRedis>>|undefined;
 const proof:Record<string,unknown>={};
 try{
  const server=createServer(app());servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const gateway=gatewayApp({CATALOG_SERVICE_URL:catalogUrl,CATALOG_REQUEST_TIMEOUT_MS:1000,ORDERS_SERVICE_URL:`http://127.0.0.1:${(server.address() as AddressInfo).port}`});
  const response=await request(gateway).post('/checkout').set('authorization',token).set('idempotency-key','observability-proof').send({}).expect(202);
  const requestId=response.headers['x-request-id'];
  const unreachable=gatewayApp({CATALOG_SERVICE_URL:catalogUrl,CATALOG_REQUEST_TIMEOUT_MS:1000,ORDERS_SERVICE_URL:'http://127.0.0.1:1'});await request(unreachable).post('/checkout').set('authorization',token).set('idempotency-key','unavailable-upstream').send({}).expect(502);
  manager.start();await vi.waitFor(()=>expect(manager.status).toBe('ready'),{timeout:20000});
  await vi.waitFor(async()=>{for(const worker of workers)await worker.runOnce();await processCheckoutPayments(payments.pool,paymentService,keys);expect((await row(response.body.orderId)).state).toBe('COMPLETED');},{timeout:25000,interval:100});
  expect(manager.counters.retried).toBeGreaterThan(0);
  const completed=await row(response.body.orderId);await manager.publish(sagaEvent('inventory.reserve.requested',{...link(completed),items:[{productId,quantity:1}]},{...keys,'orders-service':'x'.repeat(32)},completed.correlation_id));await vi.waitFor(()=>expect(manager.counters.deadLettered).toBeGreaterThan(0),{timeout:5000});
  expect(await charges()).toHaveLength(1);expect(await stock.find(productId)).toMatchObject({totalStock:4,reservedStock:0});
  const http=logs.find(l=>l.component==='http-request'&&l.service==='api-gateway'&&l.route==='/checkout');expect(http?.traceId).toBeDefined();
  expect(logs.some(l=>l.component==='http-request'&&l.service==='orders-service'&&l.requestId===requestId&&l.traceId===http?.traceId)).toBe(true);
  expect(logs.some(l=>l.component==='inbox'&&l.requestId===requestId&&l.traceId===http?.traceId)).toBe(true);
  let redisTraceId:unknown;redis=await isolatedRedis();await operation('redis-proof',{},async()=>{redisTraceId=correlation().traceId;const client=instrumentRedis(redis!.client);expect(await client.withCommandOptions({timeout:2000}).ping()).toBe('PONG');});
  f=await searchFixture();await f.products.create({name:'Telemetry fixture',priceInPaise:125,description:'Public fixture'});await f.rebuild();
  await request(f.app).get('/search/products?q=Telemetry').expect(200);await telemetry.flush();
  if(outage){expect(logs.some(l=>l.component==='messaging'&&l.outcome==='acknowledged')).toBe(true);return;}
  const search=logs.filter(l=>l.component==='http-request'&&l.service==='search-service'&&l.route==='/search/products').at(-1);expect(search?.traceId).toBeDefined();
  const retrieve=async(id:unknown)=>{let result:Record<string,unknown>|undefined;await vi.waitFor(async()=>{const r=await fetch(process.env.OBS_TEMPO_URL+'/api/traces/'+id,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(2000)});expect(r.status).toBe(200);result=await r.json() as Record<string,unknown>;expect(JSON.stringify(result)).toContain('spans');},{timeout:20000,interval:500});return result!;};
  const checkoutTrace=await retrieve(http!.traceId),searchTrace=await retrieve(search!.traceId),redisTrace=await retrieve(redisTraceId);expect(JSON.stringify(redisTrace)).toContain('redis PING');
  const topology=checkoutParentage(checkoutTrace,String(http!.traceId));
  const checkoutJSON=JSON.stringify(checkoutTrace),searchJSON=JSON.stringify(searchTrace);
  for(const expected of ['HTTP POST','http POST','rabbitmq publish','rabbitmq process','postgresql'])expect(checkoutJSON).toContain(expected);
  expect(searchJSON).toContain('elasticsearch');for(const secret of [token,userId,productId,'password','authorization','db.statement'])expect(checkoutJSON).not.toContain(secret);
  const metrics:Record<string,number>={};for(const name of ['http_server_requests_total','http_server_errors_total','http_server_request_duration_seconds_count','http_client_request_duration_seconds_count','messaging_operations_total','business_observations_total','dependency_operation_duration_seconds_count'])await vi.waitFor(async()=>{await telemetry.flush();const r=await fetch(process.env.OBS_PROMETHEUS_URL+'/api/v1/query?query='+encodeURIComponent(name),{signal:AbortSignal.timeout(2000)});const data=await r.json() as {status:string;data:{result:{metric:Record<string,string>;value:[number,string]}[]}};expect(data.status).toBe('success');expect(data.data.result.length).toBeGreaterThan(0);expect(data.data.result.length).toBeLessThanOrEqual(128);for(const series of data.data.result){expect(series.metric.service_name).toBe('observability-proof');expect(Number(series.value[1])).toBeGreaterThan(0);expect(Object.keys(series.metric).join(' ')).not.toMatch(/request.?id|trace.?id|user.?id|event.?id|idempotency/i);}metrics[name]=data.data.result.length;},{timeout:20000,interval:1000});
  proof.topology=topology;proof.serviceName='observability-proof';proof.checkout={traceId:http!.traceId,requestId,rootAndDependencies:true,committedStatus:'COMPLETED',charges:1};proof.search={traceId:search!.traceId,elasticsearch:true};proof.metrics=metrics;proof.redis={traceId:redisTraceId,ping:true};
  proof.grafana=await proveGrafana({grafanaUrl:process.env.OBS_GRAFANA_URL!,prometheusUrl:process.env.OBS_PROMETHEUS_URL!,password:(await readFile(process.env.OBS_GRAFANA_PASSWORD_FILE!,'utf8')).trim(),traceId:String(http!.traceId)});
  await writeFile(process.env.OBS_PROOF_FILE!,JSON.stringify(proof,null,2));
 }finally{
  await cleanupProof([async()=>{await f?.close();},async()=>{await redis?.close();},...workers.map(w=>()=>w.stop()),()=>manager.stop(),async()=>{
  const connection=await amqp.connect(rabbitUrl);try{const channel=await connection.createChannel();for(const spec of queueSpecs.filter(s=>settings.queues.some(name=>name===s.name))){const n=names(ns,spec);for(const q of [n.queue,n.dlq,...[1,2,3].map(i=>`${n.queue}.retry.${i}`)])await channel.deleteQueue(q);}for(const service of ['orders','inventory','payments'])await channel.deleteExchange(`${ns}.commerce.${service}.handoff`);await channel.deleteExchange(`${ns}.commerce.events`);await channel.close();}finally{await connection.close();}
  },async()=>{if(outage)await control('start');}]);
 }
}
it('retrieves the actual Gateway checkout/RabbitMQ and Search dependency traces and metrics',()=>proveFlow());
it.each(['otel-collector','tempo','prometheus','grafana'] as const)('preserves committed checkout, one charge, inventory and ACKs during %s outage',service=>proveFlow(service));
