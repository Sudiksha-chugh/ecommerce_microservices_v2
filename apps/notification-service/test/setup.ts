import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {migrate as notificationsMigrate} from '../src/db/migrate.js';
import {migrate as authMigrate} from '../../auth-service/src/db/migrate.js';
import {migrate as ordersMigrate} from '../../orders-service/src/db/migrate.js';
import {migrate as inventoryMigrate} from '../../inventory-service/src/db/migrate.js';
import {migrate as paymentsMigrate} from '../../payments-service/src/db/migrate.js';
export async function notificationIsolation(){
 const adminUrl=process.env.NOTIFICATION_TEST_ADMIN_URL??`postgresql://notification_test_admin:notification_test_only_password@127.0.0.1:${process.env.NOTIFICATION_TEST_PGPORT??55440}/postgres`;
 const u=new URL(adminUrl);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.username!=='notification_test_admin')throw new Error('Refusing non-isolated notification test administrator');
 const admin=new Pool({connectionString:adminUrl,max:2,connectionTimeoutMillis:10000,statement_timeout:15000});
 const identity=(await admin.query('SELECT current_database() AS db,current_user AS role')).rows[0];if(identity.db!=='postgres'||identity.role!=='notification_test_admin')throw new Error('Wrong isolated test cluster');
 const suffix=randomUUID().replaceAll('-','').slice(0,20),services=['notifications','email','auth','orders','inventory','payments','payment_provider'] as const;
 const records={} as Record<(typeof services)[number],{pool:Pool;url:string;database:string;role:string}>;
 const created:Array<{database:string;role:string}>=[];
 try{
  for(const service of services){const database=`p14_${service}_test_${suffix}`,role=`p14_${service}_role_${suffix}`,password=randomBytes(24).toString('hex');
   if(database.length>63||role.length>63)throw new Error('Invalid test identity');
   await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
   await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`);created.push({database,role});
   await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
   const url=`postgresql://${role}:${password}@${u.hostname}:${u.port}/${database}`;
   const pool=new Pool({connectionString:url,max:5,connectionTimeoutMillis:10000,statement_timeout:10000});pool.on('error',()=>{});records[service]={pool,url,database,role};
  }
  await notificationsMigrate(records.notifications.pool);await authMigrate(records.auth.pool);await ordersMigrate(records.orders.pool);await inventoryMigrate(records.inventory.pool);await paymentsMigrate(records.payments.pool);
  await records.email.pool.query(await readFile(new URL('../src/providers/mock-schema.sql',import.meta.url),'utf8'));
  await records.payment_provider.pool.query(await readFile(new URL('../../payments-service/src/mock-provider/schema.sql',import.meta.url),'utf8'));
  await records.payment_provider.pool.query(await readFile(new URL('../../payments-service/src/mock-provider/migrations/002-refunds.sql',import.meta.url),'utf8'));
 }catch(error){await cleanup();throw error;}
 async function cleanup(){await Promise.all(Object.values(records).map(r=>r.pool.end()));for(const r of [...created].reverse()){await admin.query(`DROP DATABASE "${r.database}" WITH (FORCE)`);await admin.query(`DROP ROLE "${r.role}"`);}await admin.end();}
 return {records,close:cleanup};
}
