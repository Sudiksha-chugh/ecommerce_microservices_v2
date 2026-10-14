import {z} from 'zod';
import {loadOrdersEnvironment} from '@ecommerce/config';
import {OutboxRepository} from '@ecommerce/event-persistence';
import {createPool,verifyDatabaseBoundary} from './db/pool.js';
const id=z.uuid().parse(process.argv[2]);const pool=createPool(loadOrdersEnvironment());
try{await verifyDatabaseBoundary(pool);const changed=await new OutboxRepository(pool).requeue(id);console.info(JSON.stringify({component:'outbox',eventId:id,outcome:changed?'operator_requeued':'not_in_review'}));}
catch{console.error('Outbox requeue failed; inspect configuration and event contract');process.exitCode=1;}
finally{await pool.end();}
