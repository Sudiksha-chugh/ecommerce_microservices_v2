import {testEnvironmentFile} from '../../../test/environment.js';
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate as ordersMigrate} from '../../../apps/orders-service/src/db/migrate.js';
import {migrate as inventoryMigrate} from '../../../apps/inventory-service/src/db/migrate.js';
import {migrate as paymentsMigrate} from '../../../apps/payments-service/src/db/migrate.js';
export async function isolated(service:'orders'|'inventory'|'payments'){
 const env=parseEnv(await readFile(testEnvironmentFile(`.env.${service}`),'utf8')),prefix=service.toUpperCase(),password=env[`${prefix}_TEST_PASSWORD`];if(!password)throw new Error('Required test password missing');
 const config={host:env[`${prefix}_PGHOST`]??'127.0.0.1',port:Number(env[`${prefix}_PGPORT`]??5432),database:`${service}_test_db`,user:`${service}_test_user`,password,max:3,connectionTimeoutMillis:2000,statement_timeout:5000};
 const admin=new Pool(config),schema=`test_${randomUUID().replaceAll('-','')}`,pool=new Pool({...config,options:`-c search_path=${schema}`});
 const identity=(await admin.query('SELECT current_database() AS db,current_user AS role')).rows[0];if(identity.db!==config.database||identity.role!==config.user)throw new Error('Refusing non-isolated database');
 await admin.query(`CREATE SCHEMA "${schema}"`);const migrate={orders:ordersMigrate,inventory:inventoryMigrate,payments:paymentsMigrate}[service];await migrate(pool);
 return {pool,config,schema,async close(){await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}};
}
