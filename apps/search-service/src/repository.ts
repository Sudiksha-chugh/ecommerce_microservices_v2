import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '@ecommerce/event-persistence';
import { PermanentHandlerError, type Event, type ProductProjection } from '@ecommerce/messaging';
function canonical(value:unknown):unknown{return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='signature').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;}
export interface Job {id:string;kind:'REBUILD'|'RECONCILE'|'ROLLBACK';status:string;index_name:string;principal:string;initial_watermark:string|null;catchup_watermark:string|null;snapshot_cursor:string;change_cursor:string|null;verify_cursor:string;audit_cursor:string;unresolved:string;processed:string;mismatches:string;retries:number;last_error:string|null}
export class SearchRepository {
 constructor(readonly pool:Pool,readonly alias:string){}
 async receive(event:Event,document:ProductProjection){const fingerprint=createHash('sha256').update(JSON.stringify(canonical(event))).digest('hex');
  const accepted=await transaction(this.pool,async client=>{
   await client.query(`INSERT INTO search_receipts(event_id,fingerprint,status,occurred_at) VALUES($1,$2,'PENDING',$3) ON CONFLICT DO NOTHING`,[event.eventId,fingerprint,event.occurredAt]);
   const row=(await client.query<{fingerprint:string;status:string}>('SELECT fingerprint,status FROM search_receipts WHERE event_id=$1 FOR UPDATE',[event.eventId])).rows[0]!;
   if(row.fingerprint!==fingerprint)return false;
   await client.query(`INSERT INTO search_projection_state(id,version,document) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document,updated_at=clock_timestamp() WHERE search_projection_state.version<EXCLUDED.version`,[document.id,document.productVersion,JSON.stringify(document)]);
   return true;
  });
  if(!accepted)throw new PermanentHandlerError();
 }
 async remember(document:ProductProjection){await this.pool.query(`INSERT INTO search_projection_state(id,version,document) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document,updated_at=clock_timestamp() WHERE search_projection_state.version<EXCLUDED.version`,[document.id,document.productVersion,JSON.stringify(document)]);}
 async latest(id:string){return (await this.pool.query<{document:ProductProjection}>('SELECT document FROM search_projection_state WHERE id=$1',[id])).rows[0]?.document;}
 async targetStates(){return (await this.pool.query<{index_name:string;status:string}>("SELECT index_name,status FROM search_targets WHERE status<>'LOST' ORDER BY index_name")).rows;}
 async targets(){return (await this.pool.query<{index_name:string}>("SELECT index_name FROM search_targets WHERE status<>'LOST' ORDER BY index_name")).rows.map(row=>row.index_name);}
 async complete(eventId:string){await this.pool.query("UPDATE search_receipts SET status='DONE',completed_at=clock_timestamp() WHERE event_id=$1",[eventId]);}
 async register(index:string){await this.pool.query("INSERT INTO search_targets(index_name,status) VALUES($1,'CANDIDATE') ON CONFLICT DO NOTHING",[index]);}
 async createJob(kind:'REBUILD'|'RECONCILE',principal:string):Promise<Job>{return transaction(this.pool,async client=>{
   // Serialize admission; durable unique constraint also protects concurrent callers.
   await client.query('SELECT pg_advisory_xact_lock(8401601)');
   if((await client.query("SELECT id FROM search_jobs WHERE status<>'COMPLETE'")).rowCount)throw new Error('Search operation already active');
   const targets=await client.query('SELECT index_name FROM search_targets');
   if(kind==='REBUILD'&&targets.rows.length>=5)throw new Error('Retained-index limit; operator cleanup required');
   const id=randomUUID();const index=kind==='REBUILD'?`${this.alias}_g_${id.replaceAll('-','')}`:this.alias;
   const job=(await client.query<Job>('INSERT INTO search_jobs(id,kind,index_name,principal) VALUES($1,$2,$3,$4) RETURNING *',[id,kind,index,principal])).rows[0]!;
   await client.query('INSERT INTO search_audit(job_id,principal,operation) VALUES($1,$2,$3)',[id,principal,kind]);return job;
  });}
 async rollback(sourceId:string,principal:string){return transaction(this.pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(8401601)');
  if((await client.query("SELECT id FROM search_jobs WHERE status<>'COMPLETE'")).rowCount)throw new Error('Operation active');
  const source=(await client.query<{index_name:string}>("SELECT j.index_name FROM search_jobs j JOIN search_targets t ON t.index_name=j.index_name WHERE j.id=$1 AND j.status='COMPLETE' AND j.kind IN ('REBUILD','ROLLBACK') AND t.status='RETAINED'",[sourceId])).rows[0];
  if(!source)throw new Error('Rollback target unavailable');const id=randomUUID();
  const job=(await client.query<Job>("INSERT INTO search_jobs(id,kind,index_name,principal) VALUES($1,'ROLLBACK',$2,$3) RETURNING *",[id,source.index_name,principal])).rows[0]!;
  await client.query("INSERT INTO search_audit(job_id,principal,operation) VALUES($1,$2,'ROLLBACK')",[id,principal]);return job;
 });}
 async job(id:string){return (await this.pool.query<Job>('SELECT * FROM search_jobs WHERE id=$1',[id])).rows[0];}
 async pending(){return (await this.pool.query<Job>("SELECT * FROM search_jobs WHERE status<>'COMPLETE' ORDER BY created_at LIMIT 1")).rows[0];}
 async status(){return {targets:(await this.pool.query('SELECT index_name,status FROM search_targets ORDER BY created_at')).rows,jobs:(await this.pool.query('SELECT id,kind,status,processed,mismatches,retries,last_error,created_at,completed_at FROM search_jobs ORDER BY created_at DESC LIMIT 20')).rows,pendingReceipts:Number((await this.pool.query("SELECT count(*) FROM search_receipts WHERE status='PENDING'")).rows[0].count)};}
}
