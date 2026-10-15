import {Pool} from 'pg';
import {InventoryRepository} from '../../inventory-service/src/inventory-repository.js';
import {inventoryCheckoutHandler} from '../../inventory-service/src/checkout-consumer.js';
import {OrderRepository} from '../src/order-repository.js';
import {SagaRepository} from '../src/saga/repository.js';
import {PaymentRepository} from '../../payments-service/src/payment-repository.js';
import {PaymentService} from '../../payments-service/src/payment-service.js';
import {ProviderClient} from '../../payments-service/src/provider-client.js';
const pool=new Pool(JSON.parse(process.env.TEST_POOL!)),mode=process.env.TEST_MODE!,keys=JSON.parse(process.env.TEST_KEYS!);
const identity=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
if(!['orders_test_db','inventory_test_db','payments_test_db'].includes(identity.db)||!identity.role.endsWith('_test_user'))throw new Error('Refusing non-test crash database');
const die=async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});};
if(mode.startsWith('inventory-')){
 const handler=inventoryCheckoutHandler(pool,new InventoryRepository(pool,1),keys,async point=>{if(mode===`inventory-${point.replace('_','-')}`)await die();});
 await handler(JSON.parse(process.env.TEST_EVENT!),{retryCount:0,redelivered:false,signal:new AbortController().signal});
}else if(mode==='order-after-commit'){
 await new OrderRepository(pool).create(process.env.TEST_USER!,'crash-creation','snapshot',JSON.parse(process.env.TEST_SNAPSHOT!),keys);await die();
}else if(mode.startsWith('saga-')){
 await new SagaRepository(pool,keys,async point=>{if((mode==='saga-after-claim'&&point==='after_claim')||(mode==='saga-before-commit'&&point==='before_recovery_commit'))await die();}).recover();
}else if(mode==='payment-after-charge'){
 const provider=new ProviderClient(process.env.TEST_PROVIDER!,1000);
 const charge=provider.charge.bind(provider);provider.charge=async(...args)=>{const result=await charge(...args);if(result.status==='SUCCEEDED')await die();return result;};
 await new PaymentService(new PaymentRepository(pool,100,10,keys),provider).operate(process.env.TEST_PAYMENT!,'process');
}
await pool.end();
