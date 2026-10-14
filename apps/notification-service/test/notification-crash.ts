import {Pool} from 'pg';
import {Messaging} from '@ecommerce/messaging';
import {NotificationRepository} from '../src/repository.js';
import {notificationHandler} from '../src/consumers/business-events.js';
import {DeterministicMockEmailProvider} from '../src/providers/mock-email.js';
import {NotificationDeliveryWorker} from '../src/workers/delivery.js';
import {RecipientResolver} from '../src/recipient-resolver.js';
const pool=new Pool({connectionString:process.env.TEST_NOTIFICATION_URL,max:3,connectionTimeoutMillis:10000}),email=new Pool({connectionString:process.env.TEST_EMAIL_URL,max:3,connectionTimeoutMillis:10000}),mode=process.env.TEST_MODE!;
const identity=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];if(!/^p14_notifications_test_[a-f0-9]+$/.test(identity.db)||!/^p14_notifications_role_[a-f0-9]+$/.test(identity.role))throw new Error('Refusing non-isolated notification crash database');
const repository=new NotificationRepository(pool,3,10,30000,()=>0.5),keys=JSON.parse(process.env.TEST_KEYS!),context={retryCount:0,redelivered:false,signal:new AbortController().signal};
const die=async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});};
if(mode.startsWith('intent-'))await notificationHandler(pool,repository,keys,async point=>{if(mode===`intent-${point.replaceAll('_','-')}`)await die();})(JSON.parse(process.env.TEST_EVENT!),context);
else if(mode==='broker-consumer-after-commit'){
 const m=new Messaging(JSON.parse(process.env.TEST_MESSAGING!),['notifications'],()=>{});m.register('notifications.business-events.v1',notificationHandler(pool,repository,keys,async point=>{if(point==='after_intent_commit')await die();}));m.start();while(m.status!=='ready')await new Promise(r=>setTimeout(r,20));process.send?.('ready');
}else await new NotificationDeliveryWorker(repository,new DeterministicMockEmailProvider(email),new RecipientResolver(process.env.TEST_AUTH_URL!,process.env.TEST_ORDERS_URL!,process.env.TEST_LOOKUP_KEY!,5000),async point=>{if(mode===point.replaceAll('_','-'))await die();}).runOnce();
if(mode!=='broker-consumer-after-commit'){await pool.end();await email.end();}
