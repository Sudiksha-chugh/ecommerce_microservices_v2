import type {Pool,PoolClient} from 'pg';
import {analyzeSqlPlan} from './sql-plan.js';
// Source-reviewed queries only. No caller SQL, parameters, relation names or EXPLAIN options.
// Generic parameters avoid inspecting production values and never invoke business functions.
const approved=Object.freeze({
 'catalog.product-by-id':{service:'catalog',table:'products',sql:'SELECT id FROM public.products WHERE id = $1::uuid'},
 'auth.user-by-id':{service:'auth',table:'users',sql:'SELECT id FROM public.users WHERE id = $1::uuid'},
 'orders.order-by-id':{service:'orders',table:'orders',sql:'SELECT id FROM public.orders WHERE id = $1::uuid'},
 'inventory.product-by-id':{service:'inventory',table:'inventory',sql:'SELECT product_id FROM public.inventory WHERE product_id = $1::uuid'},
 'payments.payment-by-id':{service:'payments',table:'payments',sql:'SELECT id FROM public.payments WHERE id = $1::uuid'},
 'notifications.notification-by-id':{service:'notifications',table:'notifications',sql:'SELECT id FROM public.notifications WHERE id = $1::uuid'},
 'search.projection-by-id':{service:'search',table:'search_projection_state',sql:'SELECT id FROM public.search_projection_state WHERE id = $1::uuid'},
});
export type DiagnosticQueryId=keyof typeof approved;
export class DiagnosticError extends Error {constructor(readonly code:'unavailable'|'busy'|'not_approved'){super('SQL diagnostic '+code);}}
// Reject privilege inheritance, memberships, ownership and grants outside a reviewed table.
// Provisioning remains an operator task; this code issues no DDL, DML or grant changes.
const boundary=`SELECT r.rolname ~ '^sql_diag_[a-z_]{1,40}$' AS named, NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit) AS restricted,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid) AS no_memberships,
 NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE') AS no_create,
 NOT pg_catalog.has_database_privilege(current_user,current_database(),'TEMP') AS no_temp,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) AS no_schema_create,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND (c.relowner=r.oid OR (c.relkind IN ('r','p','v','m','f') AND (pg_catalog.has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN,SELECT WITH GRANT OPTION') OR pg_catalog.has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES,SELECT WITH GRANT OPTION') OR ((pg_catalog.has_table_privilege(current_user,c.oid,'SELECT') OR pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT')) AND (n.nspname<>'public' OR c.relname<>$1)))))) AS table_boundary,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_sequence_privilege(current_user,c.oid,'SELECT,UPDATE,USAGE')) AS sequence_boundary,
 pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('public.' || $1),'SELECT') AS can_read,
 EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1 AND c.relkind IN ('r','p') AND NOT c.relrowsecurity) AS ordinary_table,
 current_setting('transaction_read_only')='on' AS read_only
 FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;
export class SqlDiagnostics {
 private active=0;private admitted:number[]=[];
 constructor(private pool:Pick<Pool,'connect'>,readonly service:string,private maxConcurrent=1){if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>2)throw new Error('Invalid diagnostic concurrency');}
 queries(){return Object.entries(approved).filter(([,q])=>q.service===this.service).map(([id])=>id);}
 async explain(id:string){
  if(!Object.hasOwn(approved,id))throw new DiagnosticError('not_approved');const query=approved[id as DiagnosticQueryId];if(query.service!==this.service)throw new DiagnosticError('not_approved');
  const now=performance.now();this.admitted=this.admitted.filter(time=>time>now-60000);
  if(this.active>=this.maxConcurrent||this.admitted.length>=10)throw new DiagnosticError('busy');this.admitted.push(now);this.active++;
  let client:PoolClient|undefined;
  try{
   client=await this.pool.connect();
   await client.query('BEGIN READ ONLY');
   await client.query("SET LOCAL statement_timeout = '1000ms'");
   await client.query("SET LOCAL lock_timeout = '100ms'");
   await client.query("SET LOCAL idle_in_transaction_session_timeout = '2000ms'");
   await client.query("SET LOCAL search_path = pg_catalog");
   const check=await client.query(boundary,[query.table]);const row=check.rows[0];
   if(!row||!['named','restricted','no_memberships','no_create','no_temp','no_schema_create','table_boundary','sequence_boundary','can_read','ordinary_table','read_only'].every(k=>row[k]===true))throw new DiagnosticError('unavailable');
   const result=await client.query('EXPLAIN (FORMAT JSON, GENERIC_PLAN TRUE, VERBOSE FALSE, COSTS TRUE, SETTINGS FALSE) '+query.sql);
   return {queryId:id,...analyzeSqlPlan(result.rows[0]?.['QUERY PLAN'])};
  }catch(error){if(error instanceof DiagnosticError)throw error;throw new DiagnosticError('unavailable');}
  finally{if(client){try{await client.query('ROLLBACK');client.release();}catch{client.release(true);}}this.active--;}
 }
}
