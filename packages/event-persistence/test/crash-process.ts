import {Pool} from 'pg';
import {Messaging,type Event} from '@ecommerce/messaging';
import {OrderRepository} from '../../../apps/orders-service/src/order-repository.js';
import {OutboxRepository,InboxProcessor,insertOutbox} from '../src/index.js';
const config=JSON.parse(process.env.TEST_POOL!),pool=new Pool(config),mode=process.env.TEST_CRASH_MODE!;
const identity=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];if(!['orders_test_db','inventory_test_db','payments_test_db'].includes(identity.db)||!identity.role.endsWith('_test_user'))throw new Error('Refusing non-test crash fixture');
if(mode==='order-before-commit'){
 const client=await pool.connect();await client.query('BEGIN');const id=process.env.TEST_ORDER_ID!;
 await client.query("INSERT INTO orders(id,user_id,total_amount_paise,idempotency_key,request_fingerprint) VALUES ($1::uuid,$2,100,$1::text,'crash')",[id,process.env.TEST_USER_ID]);
 const event=JSON.parse(process.env.TEST_EVENT!) as Event;await insertOutbox(client,event,id);process.send?.('before_commit');process.kill(process.pid,'SIGKILL');
}else if(mode==='order-after-commit'){
 const order=await new OrderRepository(pool).create(process.env.TEST_USER_ID!,process.env.TEST_KEY!,'crash',JSON.parse(process.env.TEST_SNAPSHOT!));process.send?.({orderId:order.id});process.kill(process.pid,'SIGKILL');
}else if(mode==='publisher-after-confirm'){
 const messaging=new Messaging(JSON.parse(process.env.TEST_MESSAGING!),['orders'],() => {});messaging.start();while(messaging.status!=='ready')await new Promise((resolve) => setTimeout(resolve,20));
 const claim=(await new OutboxRepository(pool).claim('crashed-publisher',1,100,6))[0]!;await messaging.publish(claim.envelope as Event);process.send?.('confirmed');process.kill(process.pid,'SIGKILL');
}else{
 const messaging=new Messaging(JSON.parse(process.env.TEST_MESSAGING!),['inventory'],() => {}),inbox=new InboxProcessor(pool,() => {});
 messaging.register('inventory.order-created.v1',async (event,context) => {
  if(mode==='consumer-before-commit')await inbox.process('inventory.order-created.v1',event,async (client) => {await client.query('INSERT INTO test_effects(event_id) VALUES ($1)',[event.eventId]);process.send?.('before_commit');process.kill(process.pid,'SIGKILL');},context.signal);
  else{await inbox.process('inventory.order-created.v1',event,async (client) => {await client.query('INSERT INTO test_effects(event_id) VALUES ($1)',[event.eventId]);},context.signal);process.send?.('committed');process.kill(process.pid,'SIGKILL');}
 });messaging.start();while(messaging.status!=='ready')await new Promise((resolve) => setTimeout(resolve,20));process.send?.('ready');
}
