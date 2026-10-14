import { transaction } from '@ecommerce/event-persistence';
import { CatalogClient } from './catalog-client.js';
import { SearchRepository, type Job } from './repository.js';
import { Projector } from './projector.js';
import { SearchUnavailableError } from './elasticsearch.js';
// One bounded page per step. Durable progress is safe to repeat after any crash.
export class RebuildCoordinator {
 constructor(readonly repository:SearchRepository,readonly projector:Projector,readonly catalog:CatalogClient,readonly pageSize=100){}
 async step(id?:string):Promise<boolean>{const client=await this.repository.pool.connect();let locked=false;
  try{
   locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(8401602) AS locked')).rows[0]!.locked;if(!locked)return false;
   const job=id?await this.repository.job(id):await this.repository.pending();if(!job)return false;
   const due=(await client.query<{due:boolean}>('SELECT next_attempt_at<=clock_timestamp() AS due FROM search_jobs WHERE id=$1',[job.id])).rows[0]?.due;
   if(!due||job.status==='PAUSED'||job.status==='COMPLETE')return false;
   try{await this.advance(job);return true;}
   catch(error){console.warn(JSON.stringify({component:'search-rebuild',rebuildId:job.id,rebuildStatus:job.status,indexName:job.index_name,errorCode:typeof error==='object'&&error!==null&&'code' in error&&/^[A-Z0-9_]{1,30}$/.test(String(error.code))?String(error.code):error instanceof SearchUnavailableError?'DEPENDENCY_UNAVAILABLE':'OPERATION_FAILED'}));await client.query("UPDATE search_jobs SET retries=retries+1,last_error='DEPENDENCY_UNAVAILABLE',next_attempt_at=clock_timestamp()+LEAST(30000,1000*power(2,LEAST(retries,5)))::integer*interval '1 millisecond',paused_from=CASE WHEN retries>=9 THEN status ELSE paused_from END,status=CASE WHEN retries>=9 THEN 'PAUSED' ELSE status END WHERE id=$1",[job.id]);return false;}
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(8401602)').catch(()=>{});client.release();}
 }
 private async advance(job:Job){const {pool}=this.repository;const elastic=this.projector.elastic;
  if(job.status==='PREPARING'){
   const index=job.kind!=='RECONCILE'?job.index_name:(await elastic.current())[0];if(!index)throw new SearchUnavailableError();
   if(job.kind!=='RECONCILE')await elastic.create(index);
   // Registration commits BEFORE reading initial source watermark: all later source commits dual-write here.
   await this.repository.register(index);const watermark=await this.catalog.watermark();
   await pool.query("UPDATE search_jobs SET index_name=$2,initial_watermark=$3::bigint,change_cursor=$3::text,status='SNAPSHOT',last_error=NULL WHERE id=$1",[job.id,index,watermark]);return;
  }
  if(job.status==='SNAPSHOT'){
   const rows=await this.catalog.export('state',Number(job.initial_watermark),job.snapshot_cursor,this.pageSize);
   for(const row of rows){if(job.kind==='RECONCILE')await this.compare(job,row.document);else await this.projector.write(row.document,[job.index_name]);}
   await pool.query("UPDATE search_jobs SET snapshot_cursor=$2,processed=processed+$3,last_error=NULL,status=$4 WHERE id=$1",[job.id,rows.at(-1)?.cursor??job.snapshot_cursor,rows.length,rows.length<this.pageSize?'CATCH_UP':'SNAPSHOT']);return;
  }
  if(job.status==='CATCH_UP'){
   if(job.catchup_watermark===null){const watermark=await this.catalog.watermark();await pool.query('UPDATE search_jobs SET catchup_watermark=$2 WHERE id=$1',[job.id,watermark]);return;}
   const rows=await this.catalog.export('changes',Number(job.catchup_watermark),job.change_cursor??String(job.initial_watermark),this.pageSize);
   for(const row of rows)await this.projector.write(row.document,[job.index_name]);
   await pool.query("UPDATE search_jobs SET change_cursor=$2,processed=processed+$3,status=$4,last_error=NULL WHERE id=$1",[job.id,rows.at(-1)?.cursor??job.change_cursor,rows.length,rows.length<this.pageSize?'VERIFYING':'CATCH_UP']);return;
  }
  if(job.status==='VERIFYING'){
   const rows=await this.catalog.export('state',Number(job.catchup_watermark),job.verify_cursor,this.pageSize);
   for(const row of rows){const indexed=await elastic.get(job.index_name,row.document.id);
    if(!indexed||indexed.productVersion<row.document.productVersion){await this.projector.write(row.document,[job.index_name]);const fixed=await elastic.get(job.index_name,row.document.id);if(!fixed||fixed.productVersion<row.document.productVersion)throw new SearchUnavailableError();}}
   await pool.query('UPDATE search_jobs SET verify_cursor=$2,status=$3,last_error=NULL WHERE id=$1',[job.id,rows.at(-1)?.cursor??job.verify_cursor,rows.length<this.pageSize?'AUDITING':'VERIFYING']);return;
  }
  if(job.status==='AUDITING'){
   await elastic.refresh(job.index_name);const hits=(await elastic.scan(job.index_name,job.audit_cursor||undefined,this.pageSize)).hits.hits;
   const authoritative=new Map((await this.catalog.documents(hits.map(hit=>hit._source.id))).map(doc=>[doc.id,doc]));
   let unresolved=0;
   for(const hit of hits){const reference=authoritative.get(hit._source.id);
    if(!reference||hit._source.productVersion>reference.productVersion){unresolved++;continue;}
    if(hit._source.productVersion<reference.productVersion||JSON.stringify(hit._source)!==JSON.stringify(reference)){
      await this.projector.write(reference,[job.index_name]);const fixed=await elastic.get(job.index_name,reference.id);
      if(!fixed||fixed.productVersion<reference.productVersion||fixed.productVersion===reference.productVersion&&JSON.stringify(fixed)!==JSON.stringify(reference))unresolved++;
    }
   }
   if(unresolved){this.projector.metrics.values.search_reconciliation_mismatches_total+=unresolved;}
   await pool.query('UPDATE search_jobs SET audit_cursor=$2,unresolved=unresolved+$3,mismatches=mismatches+$3,status=$4 WHERE id=$1',[job.id,hits.at(-1)?.sort[0]??job.audit_cursor,unresolved,hits.length<this.pageSize?'SWAPPING':'AUDITING']);return;
  }
  if(job.status==='SWAPPING'){
   if(job.kind!=='RECONCILE'&&Number(job.unresolved)>0){await pool.query("UPDATE search_jobs SET status='PAUSED',paused_from='AUDITING',audit_cursor='',unresolved=0,last_error='INVALID_INDEX_STATE' WHERE id=$1",[job.id]);return;}
   await elastic.refresh(job.index_name);if(job.kind!=='RECONCILE')await elastic.swap(job.index_name);
   // Alias-before-progress crash: replay observes/replaces the same alias atomically, then commits completion.
   await transaction(pool,async client=>{
    if(job.kind!=='RECONCILE'){await client.query("UPDATE search_targets SET status='RETAINED' WHERE status='ACTIVE'");await client.query("UPDATE search_targets SET status='ACTIVE' WHERE index_name=$1",[job.index_name]);}
    await client.query("UPDATE search_jobs SET status='COMPLETE',completed_at=clock_timestamp(),last_error=NULL WHERE id=$1",[job.id]);
   });
   this.projector.metrics.values.search_rebuild_duration_seconds=Number((await pool.query('SELECT extract(epoch from completed_at-created_at) AS duration FROM search_jobs WHERE id=$1',[job.id])).rows[0].duration);
  }
 }
 private async compare(job:Job,document:Parameters<Projector['write']>[0]){
  const indexed=await this.projector.elastic.get(job.index_name,document.id);
  if(!indexed||indexed.productVersion<document.productVersion||indexed.deleted!==document.deleted){
   this.projector.metrics.values.search_reconciliation_mismatches_total++;
   await this.repository.pool.query('UPDATE search_jobs SET mismatches=mismatches+1 WHERE id=$1',[job.id]);
   await this.projector.write(document);
  }
 }
 async runToCompletion(id:string,maximum=10000){for(let i=0;i<maximum;i++){const job=await this.repository.job(id);if(job?.status==='COMPLETE')return job;if(!await this.step(id))throw new SearchUnavailableError();}throw new SearchUnavailableError();}
}
