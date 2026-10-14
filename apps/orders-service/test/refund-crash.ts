import {Pool} from 'pg';
import {RefundRepository} from '../../payments-service/src/refund-repository.js';
import {RefundService} from '../../payments-service/src/refund-service.js';
import {ProviderClient} from '../../payments-service/src/provider-client.js';
import {refundHandler} from '../../payments-service/src/refund-consumer.js';
import {InventoryRepository} from '../../inventory-service/src/inventory-repository.js';
import {compensationHandler} from '../../inventory-service/src/compensation-consumer.js';
import {SagaRepository} from '../src/saga/repository.js';
const pool=new Pool(JSON.parse(process.env.TEST_POOL!)),keys=JSON.parse(process.env.TEST_KEYS!),mode=process.env.TEST_MODE!;
const identity=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];if(!['orders_test_db','inventory_test_db','payments_test_db'].includes(identity.db)||!identity.role.endsWith('_test_user'))throw new Error('Refusing non-test crash database');
const die=async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});};
const context={retryCount:0,redelivered:false,signal:new AbortController().signal};
const repo=new RefundRepository(pool,keys,100,10,async point=>{if(mode===`refund-${point.replaceAll('_','-')}`)await die();});
if(mode.includes('intent-commit'))await repo.create(process.env.TEST_PRINCIPAL!,process.env.TEST_KEY!,JSON.parse(process.env.TEST_INPUT!));
else if(mode==='refund-after-provider')await new RefundService(repo,new ProviderClient(process.env.TEST_PROVIDER!,1000),die).runOnce();
else if(mode.includes('outcome-commit'))await new RefundService(repo,new ProviderClient(process.env.TEST_PROVIDER!,1000)).runOnce();
else if(mode==='refund-consumer-after-commit'){await refundHandler(pool,repo,keys)(JSON.parse(process.env.TEST_EVENT!),context);await die();}
else if(mode==='orders-refund-after-commit'){await new SagaRepository(pool,keys,undefined,true).refundHandler(JSON.parse(process.env.TEST_EVENT!),context);await die();}
else if(mode==='orders-cancel-after-commit'){await new SagaRepository(pool,keys,undefined,true).cancel(process.env.TEST_USER!,false,process.env.TEST_ORDER!,'crash-cancel');await die();}
else if(mode.startsWith('inventory-'))await compensationHandler(pool,new InventoryRepository(pool,1),keys,async point=>{if(mode===`inventory-${point.replaceAll('_','-')}`)await die();})(JSON.parse(process.env.TEST_EVENT!),context);
else if(mode==='orders-after-claim')await new SagaRepository(pool,keys,async point=>{if(point==='after_claim')await die();},true).recover();
await pool.end();
