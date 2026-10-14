import {httpTelemetry,correlation} from '@ecommerce/observability';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '@ecommerce/event-persistence';
import { InvalidTokenError, type TokenVerifier } from '@ecommerce/security';
import { productProjectionSchema } from '@ecommerce/messaging';
import { querySchema, searchBody, CursorCodec } from './query.js';
import { SearchUnavailableError, type Elasticsearch } from './elasticsearch.js';
import type { CatalogClient } from './catalog-client.js';
import type { SearchRepository } from './repository.js';
import { SearchMetrics } from './metrics.js';
export interface AppOptions {enabled:boolean;rebuildEnabled:boolean;defaultLimit:number;maxLimit:number;cursorKey:string;elastic:Elasticsearch;catalog:CatalogClient;repository:SearchRepository;verify:TokenVerifier;metrics?:SearchMetrics;indexerReadiness?:()=>string}
export function createApp(options:AppOptions){const app=express();app.disable('x-powered-by');const metrics=options.metrics??new SearchMetrics();const codec=options.enabled?new CursorCodec(options.cursorKey):undefined;
 app.use((_req,res,next)=>{res.locals.requestId=randomUUID();res.set('X-Request-Id',res.locals.requestId);next();});
 app.use(httpTelemetry('search-service'));
 app.get('/health',(_req,res)=>res.json({status:'ok',service:'search-service'}));
 app.get('/ready',async(_req,res)=>{
  const indexer=options.indexerReadiness?.()??'disabled',active=options.enabled||options.rebuildEnabled||indexer!=='disabled';
  let ready=true;if(active){try{ready=await options.elastic.ready();await options.repository.pool.query('SELECT index_name FROM search_targets LIMIT 1');if(options.enabled){ready=ready&&(await options.elastic.current()).length===1;await options.catalog.watermark();}}catch{ready=false;}}
  res.status(ready&&['ready','disabled'].includes(indexer)?200:503).json({search:!active?'disabled':ready?'ready':'unavailable',indexer});
 });
 app.get('/search/products',async(req,res)=>{
  if(!options.enabled){res.status(404).json({error:{message:'Route not found'}});return;}
  const parsed=querySchema.safeParse(req.query);if(!parsed.success){res.status(400).json({error:{code:'INVALID_SEARCH_QUERY',message:'Invalid search query'}});return;}
  const query={...parsed.data,limit:parsed.data.limit??options.defaultLimit};if(query.limit>options.maxLimit){res.status(400).json({error:{code:'INVALID_SEARCH_QUERY',message:'Invalid search query'}});return;}
  let after:ReturnType<CursorCodec['decode']>|undefined;
  try{if(query.cursor)after=codec!.decode(query);}catch{res.status(400).json({error:{code:'INVALID_SEARCH_CURSOR',message:'Invalid or expired search cursor'}});return;}
  const start=performance.now();metrics.values.search_requests_total++;
  try{
   const result=await options.elastic.search(searchBody(query,after));if(result.timed_out)throw new SearchUnavailableError();
   const documents=result.hits.hits.map(hit=>productProjectionSchema.parse(hit._source));
   // Fail closed on authoritative Catalog availability. Never return stale hard-deleted products.
   const visible=new Set(await options.catalog.visible(documents.map(doc=>doc.id)));
   const data=documents.filter(doc=>!doc.deleted&&visible.has(doc.id)).map(doc=>({id:doc.id,name:doc.name,description:doc.description,priceInPaise:doc.priceInPaise}));
   const last=result.hits.hits.at(-1);const nextCursor=last&&result.hits.hits.length===query.limit?codec!.encode(query,last.sort):null;
   res.set('Cache-Control','no-store');res.json({data,pagination:{limit:query.limit,nextCursor}});
  }finally{const duration=performance.now()-start;metrics.duration(duration);console.info(JSON.stringify({component:'search-api',requestId:res.locals.requestId,searchDurationMs:duration,...correlation()}));}
 });
 app.use('/admin/search',async(req,res,next)=>{
  const active=options.enabled||options.rebuildEnabled||(options.indexerReadiness?.()??'disabled')!=='disabled';
  if(!active||!['GET','HEAD'].includes(req.method)&&!options.rebuildEnabled){res.status(404).json({error:{message:'Route not found'}});return;}
  try{const identity=await options.verify(req.headers.authorization);if(identity.role!=='admin'){res.status(403).json({error:{message:'Forbidden'}});return;}res.locals.identity=identity;next();}
  catch(error){if(error instanceof InvalidTokenError){res.status(401).json({error:{message:'Unauthorized'}});return;}next(error);}
 });
 app.get('/admin/search/index-status',async(_req,res)=>res.json(await options.repository.status()));
 app.get('/admin/search/metrics',(_req,res)=>res.json(metrics.snapshot()));
 app.get('/admin/search/rebuild/:id',async(req,res)=>{const id=z.uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:{message:'Invalid operation ID'}});return;}const job=await options.repository.job(id.data);if(!job){res.status(404).json({error:{message:'Operation not found'}});return;}res.json(job);});
 app.post(['/admin/search/rebuild','/admin/search/reconcile'],express.json({limit:'1kb'}),async(req,res)=>{
  if(!z.strictObject({}).safeParse(req.body??{}).success){res.status(400).json({error:{message:'Invalid operation body'}});return;}
  try{const job=await options.repository.createJob(req.path.endsWith('reconcile')?'RECONCILE':'REBUILD',res.locals.identity.id);res.status(202).json({id:job.id,status:job.status});}
  catch{res.status(409).json({error:{message:'Search operation already active or retention limit reached'}});}
 });
 app.post('/admin/search/rollback/:id',express.json({limit:'1kb'}),async(req,res)=>{
  const id=z.uuid().safeParse(req.params.id);if(!id.success||!z.strictObject({}).safeParse(req.body??{}).success){res.status(400).json({error:{message:'Invalid rollback request'}});return;}
  try{const job=await options.repository.rollback(id.data,res.locals.identity.id);res.status(202).json({id:job.id,status:job.status});}catch{res.status(409).json({error:{message:'Rollback target unavailable or operation active'}});}
 });
 app.delete('/admin/search/retained/:id',async(req,res)=>{
  const id=z.uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:{message:'Invalid operation ID'}});return;}
  const client=await options.repository.pool.connect();let locked=false;
  try{
   locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(8401602) AS locked')).rows[0]!.locked;
   const job=await options.repository.job(id.data);const targets=(await options.repository.status()).targets;
   if(!locked||!job||job.status!=='COMPLETE'||!targets.some(t=>t.index_name===job.index_name&&['RETAINED','LOST'].includes(String(t.status)))||await options.repository.pending()||(await options.elastic.current()).includes(job.index_name)){
    res.status(409).json({error:{message:'Index cannot be removed'}});return;
   }
   // Exact durable job-owned index only. A crash is safely retried through this same endpoint.
   await options.elastic.request('DELETE',`/${job.index_name}`,undefined,[404]);
   await transaction(options.repository.pool,async tx=>{await tx.query("DELETE FROM search_targets WHERE index_name=$1 AND status IN ('RETAINED','LOST')",[job.index_name]);await tx.query("INSERT INTO search_audit(job_id,principal,operation) VALUES($1,$2,'CLEANUP')",[job.id,res.locals.identity.id]);});
   res.status(204).end();
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(8401602)').catch(()=>{});client.release();}
 });
 app.post('/admin/search/rebuild/:id/resume',express.json({limit:'1kb'}),async(req,res)=>{
  const id=z.uuid().safeParse(req.params.id);if(!id.success||!z.strictObject({}).safeParse(req.body??{}).success){res.status(400).json({error:{message:'Invalid resume request'}});return;}
  const result=await options.repository.pool.query("UPDATE search_jobs SET status=paused_from,paused_from=NULL,retries=0,next_attempt_at=clock_timestamp(),last_error=NULL WHERE id=$1 AND status='PAUSED' AND paused_from IS NOT NULL RETURNING id",[id.data]);
  if(!result.rowCount){res.status(409).json({error:{message:'Operation cannot be resumed'}});return;}
  await options.repository.pool.query("INSERT INTO search_audit(job_id,principal,operation) VALUES($1,$2,'RESUME')",[id.data,res.locals.identity.id]);res.status(202).json({id:id.data});
 });
 app.use((_req,res)=>res.status(404).json({error:{message:'Route not found'}}));
 app.use(((error:unknown,_req,res,_next)=>{res.status(error instanceof SearchUnavailableError?503:500).json({error:{code:error instanceof SearchUnavailableError?'SEARCH_UNAVAILABLE':'SEARCH_INTERNAL_ERROR',message:error instanceof SearchUnavailableError?'Search temporarily unavailable':'Internal server error'}});}) satisfies express.ErrorRequestHandler);
 return app;
}
