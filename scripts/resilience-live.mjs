import {createScenarioTelemetry} from './resilience-telemetry.mjs';
import {runCompletionMatrix} from './resilience-matrix.mjs';
import {instrumentPg,instrumentRedis} from '../packages/observability/src/index.ts';
// No infrastructure parameters are accepted. All resources and endpoints are derived here.
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import amqp from 'amqplib';
import {createClient} from '@redis/client';
import {bounded} from '../packages/resilience-testing/src/bounded.ts';
import {runScenario,verifyOwnership,fixtureSchema,dependencyScenarios,completionReportSchema,OwnedFaultAdapter} from '../packages/resilience-testing/src/index.ts';
import {OrderRepository} from '../apps/orders-service/src/order-repository.ts';
import {InventoryRepository} from '../apps/inventory-service/src/inventory-repository.ts';
import {createEvent,OutboxWorker,OutboxRepository,InboxProcessor,transaction} from '../packages/event-persistence/src/index.ts';
import {Elasticsearch} from '../apps/search-service/src/elasticsearch.ts';
import {createServer} from 'node:http';
import {PaymentRepository} from '../apps/payments-service/src/payment-repository.ts';
import {PaymentService} from '../apps/payments-service/src/payment-service.ts';
import {ProviderClient} from '../apps/payments-service/src/provider-client.ts';
import {RefundRepository} from '../apps/payments-service/src/refund-repository.ts';
import {RefundService} from '../apps/payments-service/src/refund-service.ts';
import {createMockProvider} from '../apps/payments-service/src/mock-provider/app.ts';
import {SagaRepository} from '../apps/orders-service/src/saga/repository.ts';
import {allowed} from '../apps/orders-service/src/saga/state-machine.ts';
import {inventoryCheckoutHandler} from '../apps/inventory-service/src/checkout-consumer.ts';
import {paymentsCheckoutHandler,processCheckoutPayments} from '../apps/payments-service/src/checkout-consumer.ts';
import {CartRepository} from '../apps/cart-service/src/cart-repository.ts';
if(process.versions.node.split('.')[0]!=='24'||process.argv.length!==2)throw new Error('Use Node 24; no infrastructure arguments accepted');
const execute=promisify(execFile),runId=randomBytes(12).toString('hex'),project=`phase22-${runId}`;
const directory=await mkdtemp(join(tmpdir(),project+'-')),compose=join(directory,'compose.json');
const fixture=fixtureSchema.parse({runId,project,marker:'ecommerce-phase22',resources:['postgres','rabbitmq','redis','elasticsearch','orders','payments','inventory','consumer','outbox','network']});
const images={postgres:'postgres:17',rabbitmq:'rabbitmq:4.2-management',redis:'redis:8',elasticsearch:'docker.elastic.co/elasticsearch/elasticsearch:8.15.0'};
const ports={postgres:5432,rabbitmq:5672,redis:6379,elasticsearch:9200};
const labels=target=>({'io.ecommerce.phase22.owner':'ecommerce-phase22','io.ecommerce.phase22.run':runId,'io.ecommerce.phase22.target':target});
const services=Object.fromEntries(Object.entries(images).map(([target,image])=>[target,{image,labels:labels(target),ports:[`127.0.0.1:0:${ports[target]}`],...(target==='postgres'?{environment:{POSTGRES_USER:'phase22_test',POSTGRES_PASSWORD:'isolated_phase22_only',POSTGRES_DB:'phase22_test'},tmpfs:['/var/lib/postgresql/data']} :target==='rabbitmq'?{environment:{RABBITMQ_DEFAULT_USER:'phase22_test',RABBITMQ_DEFAULT_PASS:'isolated_phase22_only'},tmpfs:['/var/lib/rabbitmq:uid=999,gid=999,mode=0700']} :target==='redis'?{tmpfs:['/data']}: {environment:{'discovery.type':'single-node','xpack.security.enabled':'false','xpack.ml.enabled':'false','ingest.geoip.downloader.enabled':'false','ES_JAVA_OPTS':'-Xms256m -Xmx256m -XX:TieredStopAtLevel=1','node.store.allow_mmap':'false'},mem_limit:'768m',tmpfs:['/usr/share/elasticsearch/data:uid=1000,gid=0,mode=0770']})}]));
await writeFile(compose,JSON.stringify({services,networks:{default:{labels:{...labels('network')}}}}),{mode:0o600});
const interrupted=new AbortController();for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>interrupted.abort());
const docker=async (args,signal)=>(await execute('docker',args,{timeout:25000,maxBuffer:200000,...(signal?{signal}:{})})).stdout.trim();
const base=['compose','-p',project,'-f',compose];
const ids=new Map(),endpoints={},reports=[],checks=[],matrix=[];let networkId,pool,inventoryPool,paymentPool,mockPool,providerServer,redis,connection,exit=0;
const provenance={sourceRevision:await execute('git',['rev-parse','HEAD']).then(r=>r.stdout.trim()),sourceDigest:await digest()};
const telemetry=await createScenarioTelemetry();
async function digest(){const files=(await execute('git',['ls-files','--cached','--others','--exclude-standard','-z'],{maxBuffer:2000000})).stdout.split('\0').filter(f=>/^(apps|packages|tests|contracts|scripts|infrastructure)\//.test(f)||/^(package.*\.json|tsconfig.*\.json|vitest.*|compose.*)$/.test(f)).sort();const hash=createHash('sha256');for(const file of files){hash.update(file+'\0');hash.update(await readFile(file));hash.update('\0');}return hash.digest('hex');}
async function inspect(target,signal){const id=ids.get(target);if(!id)throw new Error('Unregistered target');const [state]=JSON.parse(await docker(['inspect',id],signal));
 const resource={id:state.Id,kind:'container',target,labels:state.Config.Labels,mounts:(state.Mounts??[]).map(m=>m.Type)};verifyOwnership(fixture,resource);return resource;}
async function action(target,operation,signal){if(!['pause','unpause','rm'].includes(operation))throw new Error('Unknown operation');const r=await inspect(target,signal);await docker([operation,...(operation==='rm'?['--force']:[]),r.id],signal);}
async function ready(fn,ms=120000){const start=Date.now();while(Date.now()-start<ms){interrupted.signal.throwIfAborted();try{return await fn();}catch{await new Promise(r=>setTimeout(r,200));}}throw new Error('Readiness deadline');}
async function check(id,fn){interrupted.signal.throwIfAborted();const start=Date.now();try{const captured=await telemetry.record(id,'interrupt',id.startsWith('postgres')?'postgres':id.startsWith('inventory')?'inventory':id.startsWith('rabbitmq')?'rabbitmq':id.startsWith('elasticsearch')?'elasticsearch':id.startsWith('outbox')?'outbox':'payments',async l=>{l.activate();try{return await fn();}finally{l.recovering();l.remove();}});const evidence=captured.result;assert(evidence&&Object.keys(evidence).length);checks.push({id,status:'passed',durationMs:Date.now()-start,evidence});}catch{checks.push({id,status:'failed',durationMs:Date.now()-start,evidence:{}});throw new Error(`CHECK_FAILED:${id}`);}}
async function pgMigrate(app,db=pool){for(const f of (await readdir(`apps/${app}-service/migrations`)).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile(`apps/${app}-service/migrations/${f}`,'utf8'));}
try{
 if(await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${project}`]))throw new Error('Project collision');
 await docker([...base,'up','-d']);
 for(const target of Object.keys(images)){const id=await docker([...base,'ps','-aq',target]);if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Nonunique owned container');ids.set(target,id);await inspect(target);const mapping=await docker([...base,'port',target,String(ports[target])]);const port=Number(mapping.split(':').at(-1));assert(Number.isInteger(port)&&port>0);endpoints[target]=port;}
 const networks=JSON.parse(await docker(['network','ls','--filter',`label=com.docker.compose.project=${project}`,'--format','json']).then(s=>'['+s.split('\n').join(',')+']'));assert.equal(networks.length,1);networkId=networks[0].ID;
 const [network]=JSON.parse(await docker(['network','inspect',networkId]));assert.equal(network.Labels['io.ecommerce.phase22.run'],runId);assert.equal(network.Labels['io.ecommerce.phase22.owner'],'ecommerce-phase22');
 pool=new Pool({host:'127.0.0.1',port:endpoints.postgres,user:'phase22_test',password:'isolated_phase22_only',database:'phase22_test',connectionTimeoutMillis:500,statement_timeout:500,query_timeout:700,max:12});pool.on('error',()=>{});pool=instrumentPg(pool);
 await ready(()=>pool.query('SELECT 1'));
 redis=createClient({url:`redis://127.0.0.1:${endpoints.redis}`,socket:{connectTimeout:500},disableOfflineQueue:true});redis.on('error',()=>{});await redis.connect();redis=instrumentRedis(redis);
 connection=await ready(()=>amqp.connect(`amqp://phase22_test:isolated_phase22_only@127.0.0.1:${endpoints.rabbitmq}`,{timeout:500}));connection.on('error',()=>{});
 const elastic=new Elasticsearch(`http://127.0.0.1:${endpoints.elasticsearch}`,'phase22_products',500);
 await ready(async()=>{assert(await elastic.ready());});
 await pool.query('CREATE SCHEMA inventory_fixture');inventoryPool=new Pool({...pool.options,password:'isolated_phase22_only',options:'-c search_path=inventory_fixture'});inventoryPool.on('error',()=>{});inventoryPool=instrumentPg(inventoryPool);
 const orders=new OrderRepository(pool),inventory=new InventoryRepository(inventoryPool,60);
 await pgMigrate('orders');await pgMigrate('inventory',inventoryPool);
 const userId=randomUUID(),productId=randomUUID(),key=randomUUID(),snapshot={totalAmountInPaise:100,items:[{productId,productName:'Fixture',unitPriceInPaise:100,quantity:1,lineTotalInPaise:100}]};
 await check('postgres-order-outbox-atomic-rollback',async()=>{
  await pool.query("CREATE FUNCTION phase22_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled fault'; END $$");
  await pool.query('CREATE TRIGGER phase22_outbox_failure BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION phase22_fail_outbox()');
  try{await assert.rejects(orders.create(userId,key,'snapshot',snapshot));assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n,0);}finally{await pool.query('DROP TRIGGER phase22_outbox_failure ON outbox_events');}return {orders:0,outboxEvents:0};
 });
 let order;
 await check('postgres-order-concurrent-idempotency',async()=>{const results=await Promise.all(Array.from({length:6},()=>orders.create(userId,key,'snapshot',snapshot)));assert.equal(new Set(results.map(r=>r.id)).size,1);order=results[0];assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1',[order.id])).rows[0].n,1);return {distinctOrders:1,committedOutboxEvents:1,concurrentRequests:6};});
 await check('inventory-last-unit-confirm-retry-release',async()=>{
  await inventory.put(productId,1);const attempts=await Promise.allSettled(Array.from({length:6},()=>inventory.reserve({orderId:randomUUID(),items:[{productId,quantity:1}]})));const successes=attempts.filter(r=>r.status==='fulfilled');assert.equal(successes.length,1);const reservation=successes[0].value;
  await Promise.all(Array.from({length:6},()=>inventory.finish(reservation.orderId,'CONFIRMED')));assert.deepEqual(await inventory.find(productId),{productId,totalStock:0,reservedStock:0,availableStock:0});
  await assert.rejects(inventory.finish(reservation.orderId,'RELEASED'));assert.equal((await inventory.find(productId)).totalStock,0);return {contenders:6,successfulReservations:1,stockAfterConfirmation:0,reservedAfterConfirmation:0};
 });
 const event=createEvent('order.cancelled',{orderId:order.id,reason:'CUSTOMER_REQUEST',cancelledAt:new Date().toISOString()});
 await check('rabbitmq-duplicate-redelivery-consumer-restart',async()=>{
  await pool.query('CREATE TABLE phase22_effects(event_id uuid PRIMARY KEY)');const channel=await connection.createConfirmChannel(),queue='phase22_inbox';await channel.assertQueue(queue,{durable:true});
  for(let i=0;i<6;i++)channel.sendToQueue(queue,Buffer.from(JSON.stringify(event)),{persistent:true});await channel.waitForConfirms();
  const effect=async client=>{await client.query('INSERT INTO phase22_effects VALUES($1)',[event.eventId]);};
  for(let i=0;i<6;i++){const message=await channel.get(queue,{noAck:false});assert(message);await new InboxProcessor(pool,()=>{}).process('phase22.consumer',JSON.parse(message.content.toString()),effect);channel.ack(message);}
  // Delivery committed then consumer loses its channel before ACK: broker redelivers.
  channel.sendToQueue(queue,Buffer.from(JSON.stringify(event)),{persistent:true});await channel.waitForConfirms();const unacked=await channel.get(queue,{noAck:false});assert(unacked);await new InboxProcessor(pool,()=>{}).process('phase22.consumer',event,effect);await channel.close();
  const restarted=await connection.createChannel();await ready(async()=>{const m=await restarted.get(queue,{noAck:false});assert(m);assert(m.fields.redelivered);await new InboxProcessor(pool,()=>{}).process('phase22.consumer',event,effect);restarted.ack(m);});await restarted.close();assert.equal((await pool.query('SELECT count(*)::int AS n FROM phase22_effects')).rows[0].n,1);return {duplicateDeliveries:6,redeliveredAfterChannelCrash:1,businessEffects:1};
 });
 await check('outbox-confirm-before-mark-ambiguity-restart',async()=>{
  const repository=new OutboxRepository(pool),channel=await connection.createConfirmChannel(),queue='phase22_outbox';await channel.assertQueue(queue,{durable:true});
  const original=repository.published.bind(repository);let fail=true;repository.published=async claim=>{if(fail)throw new Error('controlled mark failure');return original(claim);};
  const publisher={publish:async e=>{channel.sendToQueue(queue,Buffer.from(JSON.stringify(e)),{persistent:true});await channel.waitForConfirms();}};
  await new OutboxWorker(repository,publisher,{leaseMs:100},()=>{}).runOnce();assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE status='PROCESSING'")).rows[0].n,1);
  await new Promise(r=>setTimeout(r,150));fail=false;await new OutboxWorker(repository,publisher,{leaseMs:100},()=>{}).runOnce();assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE status='PUBLISHED'")).rows[0].n,1);
  assert(await channel.get(queue));assert(await channel.get(queue));await channel.close();return {confirmedDeliveries:2,publishedOutboxEvents:1};
 });
 const index='phase22_projection',document={id:productId,productVersion:2,name:'New',description:'Fixture',priceInPaise:100,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),deleted:false};
 await check('elasticsearch-duplicate-and-stale-version',async()=>{await elastic.create(index);await elastic.put(index,document);await elastic.put(index,document);await elastic.put(index,{...document,productVersion:1,name:'Stale'});assert.equal((await elastic.get(index,productId)).name,'New');return {newestVersion:2,staleVersionSubmitted:1,duplicateWrites:1};});

 await pool.query('CREATE SCHEMA payments_fixture; CREATE SCHEMA provider_fixture');
 paymentPool=new Pool({...pool.options,password:'isolated_phase22_only',options:'-c search_path=payments_fixture'});paymentPool.on('error',()=>{});paymentPool=instrumentPg(paymentPool);
 mockPool=new Pool({...pool.options,password:'isolated_phase22_only',options:'-c search_path=provider_fixture'});mockPool.on('error',()=>{});mockPool=instrumentPg(mockPool);
 await pgMigrate('payments',paymentPool);
 await mockPool.query(await readFile('apps/payments-service/src/mock-provider/schema.sql','utf8'));
 await mockPool.query(await readFile('apps/payments-service/src/mock-provider/migrations/002-refunds.sql','utf8'));
 let providerMode='lost-response';providerServer=createServer(createMockProvider(mockPool,()=>providerMode,100));await new Promise(r=>providerServer.listen(0,'127.0.0.1',r));
 const providerClient=new ProviderClient(`http://127.0.0.1:${providerServer.address().port}`,200),paymentRepo=new PaymentRepository(paymentPool,100,20),paymentService=new PaymentService(paymentRepo,providerClient);
 const keys={'orders-service':'o'.repeat(32),'inventory-service':'i'.repeat(32),'payments-service':'p'.repeat(32)};
 let payment;
 await check('payment-ambiguous-success-concurrent-reconciliation',async()=>{
  const principal=randomUUID(),intent={orderId:randomUUID(),userId,amountPaise:100,currency:'INR'},key=randomUUID();
  const created=await Promise.all(Array.from({length:5},()=>paymentService.create(principal,key,intent)));assert.equal(new Set(created.map(r=>r.paymentId)).size,1);payment=created[0];
  const first=await paymentService.operate(payment.paymentId,'process');assert.equal(first.status,'REQUIRES_RECONCILIATION');
  await new Promise(r=>setTimeout(r,30));providerMode='success';const restarted=new PaymentService(new PaymentRepository(paymentPool,100,20),providerClient);
  await Promise.all(Array.from({length:5},()=>restarted.operate(payment.paymentId,'reconcile')));assert.equal((await restarted.get(payment.paymentId)).status,'SUCCEEDED');
  assert.equal((await mockPool.query("SELECT count(*)::int AS n FROM mock_charges WHERE status='SUCCEEDED'")).rows[0].n,1);return {successfulProviderCharges:1,concurrentRequests:5};
 });
 await check('refund-ambiguous-success-restart-idempotency',async()=>{
  const repository=new RefundRepository(paymentPool,keys,100,20),principal=randomUUID(),key=randomUUID(),input={paymentId:payment.paymentId,amountPaise:100,currency:'INR',reason:'ADMIN_REQUEST'};
  const refunds=await Promise.all(Array.from({length:5},()=>repository.create(principal,key,input)));assert.equal(new Set(refunds.map(r=>r.id)).size,1);
  providerMode='lost-response';const service=new RefundService(repository,providerClient);await service.reconcile(refunds[0].id);assert.equal((await repository.get(refunds[0].id)).status,'REQUIRES_RECONCILIATION');
  await new Promise(r=>setTimeout(r,130));providerMode='success';const restarted=new RefundService(new RefundRepository(paymentPool,keys,100,20),providerClient);await restarted.reconcile(refunds[0].id);
  assert.equal((await repository.get(refunds[0].id)).status,'SUCCEEDED');assert.equal((await mockPool.query("SELECT count(*)::int AS n FROM mock_refunds WHERE status='SUCCEEDED'")).rows[0].n,1);return {successfulProviderRefunds:1,distinctRefundIntents:1,concurrentRequests:5};
 });

 await check('checkout-inventory-process-crash-redelivery-compensation',async()=>{
  const sagaProduct=randomUUID();await inventory.put(sagaProduct,1);const sagaSnapshot={totalAmountInPaise:100,items:[{productId:sagaProduct,productName:'Saga fixture',unitPriceInPaise:100,quantity:1,lineTotalInPaise:100}]};
  const checkout=await orders.create(userId,randomUUID(),'saga-snapshot',sagaSnapshot,keys),context={retryCount:0,redelivered:true,signal:new AbortController().signal};
  const events=async(db,type)=>(await db.query('SELECT envelope FROM outbox_events WHERE aggregate_id=$1 AND event_type=$2 ORDER BY created_at,id',[checkout.id,type])).rows.map(r=>r.envelope);
  const reserve=(await events(pool,'inventory.reserve.requested'))[0];assert(reserve);await inspect('postgres');
  const child=fork(new URL('./resilience-crash-child.mjs',import.meta.url),[],{execArgv:['--import','tsx'],env:{PATH:process.env.PATH,PHASE22_PROJECT:project,PHASE22_PGPORT:String(endpoints.postgres),PHASE22_EVENT:JSON.stringify(reserve)},stdio:['ignore','ignore','ignore','ipc']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Crash child deadline'));},5000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',(_code,signal)=>{clearTimeout(timer);signal==='SIGKILL'?resolve():reject(new Error('Expected owned child crash'));});});
  const inventoryHandler=inventoryCheckoutHandler(inventoryPool,inventory,keys);await inventoryHandler(reserve,context);
  assert.equal((await inventory.find(sagaProduct)).reservedStock,1);assert.equal((await events(inventoryPool,'checkout.inventory.reserved')).length,1);
  const saga=new SagaRepository(pool,keys);await saga.handler((await events(inventoryPool,'checkout.inventory.reserved'))[0],context);
  const paymentRepository=new PaymentRepository(paymentPool,100,20,keys),paymentHandler=paymentsCheckoutHandler(paymentPool,paymentRepository,keys);providerMode='decline';
  await paymentHandler((await events(pool,'payment.process.requested'))[0],context);await processCheckoutPayments(paymentPool,new PaymentService(paymentRepository,providerClient),keys);
  await saga.handler((await events(paymentPool,'checkout.payment.failed'))[0],context);
  const release=(await events(pool,'inventory.release.requested'))[0];await inventoryHandler(release,context);await inventoryHandler(release,context);
  await saga.handler((await events(inventoryPool,'checkout.inventory.released'))[0],context);
  const state=(await pool.query('SELECT state FROM checkout_sagas WHERE order_id=$1',[checkout.id])).rows[0].state;assert.equal(state,'COMPENSATED');assert.equal((await orders.findById(userId,checkout.id)).status,'FAILED');assert.equal((await inventory.find(sagaProduct)).availableStock,1);
  const transitions=(await pool.query('SELECT t.from_state,t.to_state FROM checkout_saga_transitions t JOIN checkout_sagas s ON s.id=t.saga_id WHERE s.order_id=$1',[checkout.id])).rows;
  assert(transitions.every(t=>t.from_state===null||allowed(t.from_state,t.to_state)));
  assert.equal((await mockPool.query("SELECT count(*)::int AS n FROM mock_charges WHERE status='SUCCEEDED'")).rows[0].n,1);return {crashedProcesses:1,reservationEffects:1,restoredAvailableStock:1,invalidSagaTransitions:0};
 });
 await runCompletionMatrix({fixture,pool,inventoryPool,paymentPool,mockPool,connection,ports:{...endpoints,userId,provider:`http://127.0.0.1:${providerServer.address().port}`},telemetry,inspect,providerClient,setProviderMode:mode=>{providerMode=mode;},keys,userId,order,matrix,signal:interrupted.signal});
 await new Promise(r=>providerServer.close(r));providerServer=undefined;await paymentPool.end();paymentPool=undefined;await mockPool.end();mockPool=undefined;
 const cart=new CartRepository(redis,60,150,'phase22_cart:');await cart.add(userId,productId,1);
 const expectedOrders=(await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
 for(const target of ['redis','rabbitmq','elasticsearch','postgres']){
  const scenario=dependencyScenarios.find(s=>s.target===target);assert(scenario);
  const captured=await telemetry.record(scenario.id,scenario.fault,target,async lifecycle=>{
   let paused=false,cleaned=false;const started=Date.now();
   const probe=async()=>{if(target==='postgres')await pool.query('SELECT 1');else if(target==='redis')await bounded(AbortSignal.timeout(200),()=>redis.ping());else if(target==='elasticsearch')assert(await elastic.ready());else {const c=await amqp.connect(`amqp://phase22_test:isolated_phase22_only@127.0.0.1:${endpoints.rabbitmq}`,{timeout:300});c.on('error',()=>{});await c.close();}};
   const adapter=new OwnedFaultAdapter({kind:'dependency',target,durationMs:5000},fixture,{target,inspect:signal=>inspect(target,signal),activate:async(_config,signal)=>{await action(target,'pause',signal);paused=true;lifecycle.activate();},recover:async signal=>{lifecycle.recovering();const resource=await inspect(target,signal);const [state]=JSON.parse(await docker(['inspect',resource.id],signal));if(state.State.Paused){await action(target,'unpause',signal);paused=false;}await ready(probe,5000);lifecycle.remove();},cleanup:async signal=>{
    if(target==='postgres'){await inventoryPool.end();inventoryPool=undefined;await pool.end();pool=undefined;}if(target==='redis'){redis.destroy();redis=undefined;}if(target==='rabbitmq'){await connection.close();connection=undefined;}
    await action(target,'rm',signal);ids.delete(target);cleaned=true;return (await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${project}`,'--filter',`label=io.ecommerce.phase22.target=${target}`],signal))==='';
   }});
   const controller={inspect:async(_fixture,_target,signal)=>inspect(target,signal),precondition:async name=>{if(name==='healthy')await probe();return true;},activate:(_scenario,signal)=>adapter.activate(signal),observe:async(_scenario,signal)=>{
    let rejected=false;try{if(target==='redis')await cart.find(userId);else if(target==='postgres')await orders.create(userId,randomUUID(),'snapshot',snapshot);else await probe();}catch{rejected=true;}
    await adapter.recover(signal);
    if(target==='redis')assert.equal((await cart.find(userId)).items.length,1);if(target==='postgres'){assert.equal((await orders.findByKey(userId,key)).order.id,order.id);assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,expectedOrders);}if(target==='elasticsearch')assert.equal((await elastic.get(index,productId)).productVersion,2);
    return {'no-false-success':{observed:rejected?0:1,limit:0,complete:true,elapsedMs:Date.now()-started},'eventual-recovery':{observed:0,limit:0,complete:true,elapsedMs:Date.now()-started}};
   },recover:async signal=>{await adapter.recover(signal);return true;},cleanup:signal=>adapter.cleanup(signal)};
   const report=await runScenario(scenario,fixture,controller,{...provenance,allowlist:[scenario.id],signal:interrupted.signal});reports.push(report);console.log(JSON.stringify({scenarioId:scenario.id,status:report.status}));if(report.status!=='passed'||!cleaned)throw new Error('Scenario did not pass');return report;
  });assert.equal(captured.telemetry.status,'verified');
 }

}catch(error){exit=1;console.error(error instanceof Error?error.message.replace(/(?:postgresql|amqp|redis):\/\/\S+/g,'[redacted]'):'LIVE_FAILED');}
finally{

 // Discover partially created resources after a failed Compose startup, then inspect every target before mutation.
 for(const target of Object.keys(images))if(!ids.has(target)){const id=await docker([...base,'ps','-aq',target]).catch(()=>undefined);if(id&&/^[a-f0-9]{64}$/.test(id))ids.set(target,id);}
 if(!networkId){const candidates=await docker(['network','ls','-q','--no-trunc','--filter',`label=com.docker.compose.project=${project}`]).catch(()=>undefined);if(candidates&&/^[a-f0-9]{64}$/.test(candidates))networkId=candidates;}
 for(const target of ids.keys())try{const [state]=JSON.parse(await docker(['inspect',ids.get(target)]));if(state.State.Paused)await action(target,'unpause');}catch{}
 const close=fn=>bounded(AbortSignal.timeout(2000),async()=>fn());
 try{providerServer?.closeAllConnections();if(providerServer)await close(()=>new Promise(r=>providerServer.close(r)));}catch{}try{await close(()=>paymentPool?.end());}catch{}try{await close(()=>mockPool?.end());}catch{}try{await close(()=>inventoryPool?.end());}catch{}try{await close(()=>pool?.end());}catch{}try{redis?.destroy();}catch{}try{await close(()=>connection?.close());}catch{}
 let cleanup=true;for(const target of ids.keys()){try{const [state]=JSON.parse(await docker(['inspect',ids.get(target)]));if(state.State.Paused)await action(target,'unpause');await action(target,'rm');}catch{cleanup=false;}}
 if(networkId)try{const [network]=JSON.parse(await docker(['network','inspect',networkId]));assert.equal(network.Labels['io.ecommerce.phase22.run'],runId);assert.equal(network.Labels['io.ecommerce.phase22.owner'],'ecommerce-phase22');assert.equal(network.Labels['com.docker.compose.project'],project);assert.equal(Object.keys(network.Containers??{}).length,0);await docker(['network','rm',network.Id]);}catch{cleanup=false;}
 const leftover=await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${project}`]).catch(()=>'?');cleanup=cleanup&&leftover==='';
 await telemetry.shutdown();
 await writeFile('docs/phase-22-live-results.json',JSON.stringify(completionReportSchema.parse({schemaVersion:1,...provenance,fixture,reports,checks,matrix,telemetry:telemetry.evidence,cleanup:{verified:cleanup},status:exit===0&&cleanup?'passed':'failed'}),null,2)+'\n');
 if(cleanup)await rm(directory,{recursive:true,force:true});else {console.error(`Manual recovery required: ${project}; fixture directory retained`);exit=1;}
}
process.exitCode=exit;
