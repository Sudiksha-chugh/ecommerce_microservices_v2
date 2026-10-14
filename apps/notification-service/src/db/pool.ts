import {Pool} from 'pg';
export function notificationPool(url:string){const pool=new Pool({connectionString:url,max:10,connectionTimeoutMillis:10000,statement_timeout:10000});pool.on('error',()=>console.error(JSON.stringify({component:'notifications-db',outcome:'connection_failed'})));return pool;}
export async function verifyNotificationBoundary(pool:Pool,expected='notifications_db'){
 const r=(await pool.query(`SELECT current_database() AS db,r.rolsuper,EXISTS(SELECT 1 FROM pg_database d WHERE d.datname IN ('auth_db','catalog_db','orders_db','payments_db','inventory_db','mock_email_provider_db') AND has_database_privilege(current_user,d.oid,'CONNECT')) AS other_access FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
 if(!r||r.db!==expected||r.rolsuper||r.other_access)throw new Error('Notifications requires its dedicated non-superuser database role');
}
