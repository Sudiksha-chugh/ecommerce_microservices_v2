// Test-only IPC worker. No production config, HTTP fault endpoint or user-selected code.
import {createServer} from 'node:http';
import {Pool} from 'pg';
import amqp from 'amqplib';
import {z} from 'zod';
import {validateEvent} from '../packages/messaging/src/index.ts';
import {createApp as createOrdersApp} from '../apps/orders-service/src/app.ts';
import {createJwtFixture} from '../test/jwt-fixture.ts';
import {OrderRepository} from '../apps/orders-service/src/order-repository.ts';
import {OutboxRepository,OutboxWorker,InboxProcessor} from '../packages/event-persistence/src/index.ts';
import {PaymentRepository} from '../apps/payments-service/src/payment-repository.ts';
import {PaymentService} from '../apps/payments-service/src/payment-service.ts';
import {ProviderClient} from '../apps/payments-service/src/provider-client.ts';
import {RefundRepository} from '../apps/payments-service/src/refund-repository.ts';
import {RefundService} from '../apps/payments-service/src/refund-service.ts';
import {inventoryCheckoutHandler} from '../apps/inventory-service/src/checkout-consumer.ts';
import {InventoryRepository} from '../apps/inventory-service/src/inventory-repository.ts';
if(!process.send||!/^phase22-[a-f0-9]{24}$/.test(process.env.PHASE22_PROJECT??''))throw new Error('Owned IPC worker required');
const mode=z.enum(['service','outbox','payment','refund','consumer','inventory']).parse(process.env.PHASE22_MODE),port=z.coerce.number().int().min(1).max(65535).parse(process.env.PHASE22_PGPORT);
const schema=mode==='payment'||mode==='refund'?'payments_fixture':mode==='inventory'?'inventory_fixture':mode==='outbox'?'outbox_fixture':'public';
const pool=new Pool({host:'127.0.0.1',port,database:'phase22_test',user:'phase22_test',password:'isolated_phase22_only',options:`-c search_path=${schema}`,connectionTimeoutMillis:1000,statement_timeout:2000});
const identity=(await pool.query('SELECT current_database() AS db,current_user AS role,current_schema() AS schema')).rows[0];if(identity.db!=='phase22_test'||identity.role!=='phase22_test'||identity.schema!==schema)throw new Error('FOREIGN_DATABASE');
const keys={'orders-service':'o'.repeat(32),'inventory-service':'i'.repeat(32),'payments-service':'p'.repeat(32)},runId=process.env.PHASE22_PROJECT.slice(8),queue=`phase22_${runId}`;
const die=async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});};
let server;
let authorization;
if(mode==='service'){const repository=new OrderRepository(pool),jwt=await createJwtFixture(),userId=z.uuid().parse(process.env.PHASE22_USER_ID);authorization=`Bearer ${await jwt.sign('customer',{sub:userId})}`;const app=createOrdersApp({findById:(userId,id)=>repository.findById(userId,id)},jwt.verify);server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));}
process.send({ready:true,...(server?{origin:`http://127.0.0.1:${server.address().port}`,authorization}:{})});
process.once('disconnect',()=>{server?.closeAllConnections();server?.close();const timer=setTimeout(()=>process.exit(process.exitCode??0),2000);timer.unref();void pool.end().catch(()=>{}).finally(()=>{clearTimeout(timer);process.exit(process.exitCode??0);});});
process.once('message',async message=>{try{
 const job=z.strictObject({id:z.uuid().optional(),event:z.unknown().optional(),recover:z.boolean().optional()}).parse(message.job);
 if(mode==='inventory'){await inventoryCheckoutHandler(pool,new InventoryRepository(pool,60),keys,async point=>{if(point==='after_commit'&&!job.recover)await die();})(validateEvent(job.event),{retryCount:0,redelivered:false,signal:new AbortController().signal});}
 else if(mode==='payment'||mode==='refund'){
  const origin=new URL(process.env.PHASE22_PROVIDER);if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:')throw new Error('FOREIGN_PROVIDER');const provider=new ProviderClient(origin.origin,1000);
  if(mode==='payment'){const charge=provider.charge.bind(provider);provider.charge=async(...args)=>{const result=await charge(...args);if(result.status==='SUCCEEDED'&&!job.recover)await die();return result;};await new PaymentService(new PaymentRepository(pool,150,20),provider).operate(z.uuid().parse(job.id),job.recover?'reconcile':'process');}
  else await new RefundService(new RefundRepository(pool,keys,150,20),provider,job.recover?async()=>{}:die).reconcile(z.uuid().parse(job.id));
 }else if(mode==='outbox'||mode==='consumer'){
  const brokerPort=z.coerce.number().int().min(1).max(65535).parse(process.env.PHASE22_AMQPPORT),connection=await amqp.connect(`amqp://phase22_test:isolated_phase22_only@127.0.0.1:${brokerPort}`,{timeout:1000}),channel=await connection.createConfirmChannel();await channel.assertQueue(queue,{durable:true});
  if(mode==='outbox')await new OutboxWorker(new OutboxRepository(pool),{publish:async event=>{channel.sendToQueue(queue,Buffer.from(JSON.stringify(event)),{persistent:true});await channel.waitForConfirms();if(!job.recover)await die();}},{leaseMs:150,batchSize:1},()=>{}).runOnce();
  else {const message=await channel.get(queue,{noAck:false});if(!message)throw new Error('MISSING_DELIVERY');const event=validateEvent(JSON.parse(message.content.toString()));await new InboxProcessor(pool,()=>{}).process('phase22.boundary',event,async client=>{await client.query('INSERT INTO phase22_boundary_effects VALUES($1)',[event.eventId]);});if(!job.recover)await die();channel.ack(message);process.send({done:true,redelivered:message.fields.redelivered});await channel.close();await connection.close();return;}
  await channel.close();await connection.close();
 }
 if(job.recover){process.send({done:true});return;}throw new Error('Expected crash point not reached');
}catch{process.exitCode=1;await pool.end();process.disconnect();}});
