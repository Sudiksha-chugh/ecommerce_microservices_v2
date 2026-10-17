// Owned child capability, launched only by resilience-live.mjs. No standalone CLI.
import {Pool} from 'pg';
import {inventoryCheckoutHandler} from '../apps/inventory-service/src/checkout-consumer.ts';
import {InventoryRepository} from '../apps/inventory-service/src/inventory-repository.ts';
if(!process.send||!/^phase22-[a-f0-9]{24}$/.test(process.env.PHASE22_PROJECT??''))throw new Error('Owned IPC child required');
const port=Number(process.env.PHASE22_PGPORT);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid fixture port');
const pool=new Pool({host:'127.0.0.1',port,database:'phase22_test',user:'phase22_test',password:'isolated_phase22_only',options:'-c search_path=inventory_fixture',connectionTimeoutMillis:1000,statement_timeout:2000});
const identity=(await pool.query('SELECT current_database() AS db,current_user AS role,current_schema() AS schema')).rows[0];
if(identity.db!=='phase22_test'||identity.role!=='phase22_test'||identity.schema!=='inventory_fixture')throw new Error('Foreign database');
const keys={'orders-service':'o'.repeat(32),'inventory-service':'i'.repeat(32),'payments-service':'p'.repeat(32)};
const handler=inventoryCheckoutHandler(pool,new InventoryRepository(pool,60),keys,async point=>{if(point==='after_commit'){process.kill(process.pid,'SIGKILL');await new Promise(()=>{});}});
await handler(JSON.parse(process.env.PHASE22_EVENT),{retryCount:0,redelivered:false,signal:new AbortController().signal});
throw new Error('Expected crash point not reached');
