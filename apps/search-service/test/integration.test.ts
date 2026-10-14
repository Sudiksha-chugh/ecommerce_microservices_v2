import { closeScenario } from './cleanup-stack.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import amqp from 'amqplib';
import { Pool } from 'pg';
import { beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi } from 'vitest';
import request, {type Response} from 'supertest';
import { OutboxRepository,OutboxWorker } from '@ecommerce/event-persistence';
import { signProducerEvent,validateEvent, type Event } from '@ecommerce/messaging';
import { internalHeaders } from '@ecommerce/security';
import { RedisRateLimitStore,DistributedRateLimiter,defaultPolicies } from '@ecommerce/rate-limiting';
import { isolatedRedis,redisProxy } from '../../../packages/rate-limiting/test/fixture.js';
import { createApp as gatewayApp } from '../../api-gateway/src/app.js';
import { createApp } from '../src/app.js';
import { Elasticsearch, SearchUnavailableError, InvalidProjectionError } from '../src/elasticsearch.js';
import { CatalogClient } from '../src/catalog-client.js';
import { Projector } from '../src/projector.js';
import { RebuildCoordinator } from '../src/rebuild.js';
import { emptyOwnedIndex } from './cleanup.js';
import { searchFixture,until,eventKey,lookupKey,cursorKey,elasticProxy } from './fixture.js';
let f:Awaited<ReturnType<typeof searchFixture>>;
let rateRedis:Awaited<ReturnType<typeof isolatedRedis>>;
const cleanup:(()=>Promise<unknown>)[]=[];
// Each scenario includes several independently bounded 2s RPCs and/or two 5s process/broker waits.
// This is a scenario budget, not an increased application command timeout or a changed legacy test setting.
describe('isolated multi-service Search integration',{timeout:20000},()=>{
beforeAll(async()=>{
 const setup=async<T>(name:string,create:()=>Promise<T>)=>{
  const started=performance.now();
  try{const value=await create();console.info(JSON.stringify({at:new Date().toISOString(),durationMs:performance.now()-started,component:'search-test',fixture:name,stage:'ready'}));return value;}
  catch(error){console.error(JSON.stringify({component:'search-test',fixture:name,stage:'failed',error:error instanceof Error?error.message:String(error)}));throw error;}
 };
 const results=await Promise.allSettled([setup('search',searchFixture),setup('redis',isolatedRedis)]);
 if(results[0].status==='fulfilled')f=results[0].value;
 if(results[1].status==='fulfilled')rateRedis=results[1].value;
 for(const result of results)if(result.status==='rejected')throw result.reason instanceof Error?result.reason:new Error(`Fixture setup rejected: ${JSON.stringify(result.reason)}`);
},120000);
afterAll(async()=>{await rateRedis?.close();await f?.close();},60000);
beforeEach(async()=>{
 await f.setupStage('FIXTURE_RESET','postgres-rabbitmq-elasticsearch',async()=>{
 await f.quiesce();
 for(const queue of [...[1,2,3].map(i=>`search.product-events.v1.retry.${i}`),'search.product-events.v1','search.product-events.dlq'])await f.channel.purgeQueue(queue);
 // The baseline generation was built through the real coordinator in beforeAll.
 // Reset its owned data, rather than running seven production rebuild phases
 // before every unrelated query/contract test. Rebuild scenarios below still
 // execute the complete lifecycle, and index-loss scenarios recreate it here.
 const baseline=f.initial.index_name;
 const indexes=(await f.searchPool.query('SELECT index_name FROM search_targets UNION SELECT index_name FROM search_jobs')).rows.map(row=>row.index_name as string);
 for(const index of indexes)if(index!==baseline&&index.startsWith(f.alias+'_g_'))await until(async()=>{try{await f.elastic.request('DELETE',`/${index}`,undefined,[404]);return true;}catch{return false;}},5000);
 await f.searchPool.query('TRUNCATE search_receipts,search_projection_state');
 await f.searchPool.query('DELETE FROM search_audit WHERE job_id<>$1',[f.initial.id]);await f.searchPool.query('DELETE FROM search_jobs WHERE id<>$1',[f.initial.id]);
 await f.searchPool.query('DELETE FROM search_targets WHERE index_name<>$1',[baseline]);
 await f.catalogPool.query('TRUNCATE products,catalog_search_documents,catalog_search_changes,outbox_events');await f.catalogPool.query('UPDATE catalog_search_clock SET sequence=0');
 const mapping=await f.elastic.request<Record<string,unknown>>('GET',`/${baseline}/_mapping`,undefined,[404]);
 if(!mapping[baseline]){await f.searchPool.query('TRUNCATE search_audit,search_jobs,search_targets RESTART IDENTITY');f.initial=await f.rebuild();return;}
 await emptyOwnedIndex(f.elastic,baseline,f.quiesce);
 if((await f.elastic.current()).join()!==baseline)await f.elastic.swap(baseline);
 await f.searchPool.query("UPDATE search_targets SET status='ACTIVE' WHERE index_name=$1",[baseline]);
 });
},15000);
afterEach(async()=>{await closeScenario(cleanup,()=>vi.restoreAllMocks());});
const make=async(name='Wireless Headphones',priceInPaise=249900,description='Bluetooth audio and music')=>f.products.create({name,priceInPaise,description});
const active=async()=>(await f.elastic.current())[0]!;
async function apply(id:string){const event=await f.event(id);await f.projector.consume(event,eventKey);return event;}
async function refresh(){for(const index of await f.repository.targets())await f.elastic.refresh(index);}
async function seedSearch(){const a=await make('Wireless Headphones',249900),b=await make('Coffee Mug',15000,'Ceramic drinking cup'),c=await make('Desk Lamp',50000,'Bright Bluetooth office light');await apply(a.id);await apply(b.id);await apply(c.id);await refresh();return {a,b,c};}
function child(operation:'consumer'|'rebuild',checkpoint:string,jobId?:string){
 const process=spawn(globalThis.process.execPath,['--import','tsx','apps/search-service/test/process.ts'],{env:{...globalThis.process.env,TEST_OPERATION:operation,TEST_CHECKPOINT:checkpoint,TEST_JOB_ID:jobId,TEST_SEARCH_URL:f.searchUrl,TEST_ALIAS:f.alias,TEST_ELASTIC_URL:f.elasticOrigin,TEST_CATALOG_URL:f.catalogOrigin,TEST_LOOKUP_KEY:lookupKey,TEST_BROKER_URL:f.brokerUrl,TEST_EVENT_KEY:eventKey},stdio:['ignore','pipe','pipe','ipc']});
 let error='';process.stderr!.on('data',data=>error+=data.toString());process.stdout!.resume();const seen=new Set<string>();process.on('message',(message:unknown)=>{if(message&&typeof message==='object'&&'checkpoint' in message)seen.add(String(message.checkpoint));});
 const exited=new Promise<void>(resolve=>process.once('exit',()=>resolve()));cleanup.push(async()=>{if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');await exited;});
 return {process,exited,wait:async(label:string,budget=5000)=>{await until(()=>{if(process.exitCode!==null)throw new Error(`Search subprocess failed: ${error}`);return seen.has(label);},budget);}};
}
describe('fixture cleanup regression',()=>{
 it('removes unrefreshed writes and preserves a different owned fixture prefix',async()=>{
  const index=await active(),p=await make();
  // Register restoration before sending: an ambiguous reply can still have changed the setting.
  cleanup.push(()=>f.elastic.request('PUT',`/${index}/_settings`,{index:{refresh_interval:'1s'}}));
  await f.elastic.request('PUT',`/${index}/_settings`,{index:{refresh_interval:'-1'}});
  const other=new Elasticsearch(f.elasticOrigin,f.alias+'_other'),otherIndex=other.alias+'_g_1';
  await other.create(otherIndex);cleanup.push(()=>other.request('DELETE',`/${otherIndex}`,undefined,[404]));
  const doc=(await f.event(p.id)).payload as {product:Parameters<typeof f.elastic.put>[1]};
  await f.elastic.put(index,doc.product);await other.put(otherIndex,doc.product);
  expect((await f.elastic.request<{hits:{total:{value:number}}}>('POST',`/${index}/_search`,{size:0,query:{match_all:{}}})).hits.total.value).toBe(0);
  await emptyOwnedIndex(f.elastic,index,f.quiesce);
  expect(await f.elastic.get(index,p.id)).toBeUndefined();expect(await other.get(otherIndex,p.id)).toBeDefined();
  await expect(emptyOwnedIndex(f.elastic,otherIndex,f.quiesce)).rejects.toThrow('Unowned');
 });
 it('waits for an in-flight consumer write before taking the deletion snapshot',async()=>{
  const p=await make(),event=await f.event(p.id);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  await f.consumer(async event=>{entered();await gate;await f.projector.consume(event,eventKey);});
  await f.publisher.publish(event);await started;let finished=false;
  const reset=emptyOwnedIndex(f.elastic,await active(),f.quiesce).then(()=>{finished=true;});
  try{await new Promise(resolve=>setImmediate(resolve));expect(finished).toBe(false);}finally{release();}
  await reset;expect(finished).toBe(true);expect(await f.elastic.get(await active(),p.id)).toBeUndefined();
 });
 it('can repeat an interrupted deletion without leaving stale data for rollback audits',async()=>{
  const p=await make();await apply(p.id);const index=await active(),proxy=await elasticProxy(f.elasticOrigin);cleanup.push(()=>proxy.close());
  proxy.pause('/_delete_by_query');const deletion=emptyOwnedIndex(new Elasticsearch(proxy.origin,f.alias),index,f.quiesce);
  const failed=expect(deletion).rejects.toThrow();await proxy.captured();await failed;proxy.release();await emptyOwnedIndex(f.elastic,index,f.quiesce);expect(await f.elastic.get(index,p.id)).toBeUndefined();
  const job=await f.rebuild();expect(job.status).toBe('COMPLETE');
 });
});
describe('Catalog transactional source and version contracts',()=>{
 it('persists create/update/delete with outbox and durable monotonic tombstone versions',async()=>{const p=await make();await f.products.update(p.id,{priceInPaise:10});await f.products.delete(p.id);const events=(await f.catalogPool.query('SELECT envelope FROM outbox_events WHERE aggregate_id=$1 ORDER BY (payload->>\'productVersion\')::bigint',[p.id])).rows.map(row=>validateEvent(row.envelope));expect(events.map(event=>(event.payload as {productVersion:number}).productVersion)).toEqual([1,2,3]);expect(events.map(event=>event.eventType)).toEqual(['catalog.product.created','catalog.product.updated','catalog.product.deleted']);expect((await f.source.export({mode:'state',through:3,after:'',limit:100}))[0]?.document.deleted).toBe(true);expect(await f.products.findById(p.id)).toBeUndefined();});
 it('rolls back the product, version clock, journal and outbox together',async()=>{const client=await f.catalogPool.connect();try{await client.query('BEGIN');await client.query("INSERT INTO products(name,description,price_in_paise) VALUES('rolled back','',1)");await client.query('ROLLBACK');}finally{client.release();}expect(await f.products.findAll()).toEqual([]);expect(await f.source.watermark()).toBe(0);expect((await f.catalogPool.query('SELECT count(*) FROM outbox_events')).rows[0].count).toBe('0');});
 it('constraint failure cannot commit an orphan outbox row or version increment',async()=>{await expect(f.catalogPool.query("INSERT INTO products(name,description,price_in_paise) VALUES('invalid','',-1)")).rejects.toThrow();expect(await f.source.watermark()).toBe(0);expect((await f.catalogPool.query('SELECT count(*) FROM catalog_search_changes')).rows[0].count).toBe('0');});
 it('concurrent committed updates cannot reuse product versions',async()=>{const p=await make();await Promise.all(Array.from({length:10},(_,i)=>f.products.update(p.id,{priceInPaise:i})));const versions=(await f.catalogPool.query('SELECT (payload->>\'productVersion\')::int AS version FROM outbox_events WHERE aggregate_id=$1 ORDER BY version',[p.id])).rows.map(row=>row.version);expect(versions).toEqual(Array.from({length:11},(_,i)=>i+1));});
 it('recreation of a hard-deleted UUID advances its durable version',async()=>{const p=await make();await f.products.delete(p.id);await f.catalogPool.query("INSERT INTO products(id,name,description,price_in_paise) VALUES($1,'recreated','',1)",[p.id]);expect((await f.event(p.id)).payload).toMatchObject({productVersion:3});});
 it('publisher confirms mark only committed routable outbox events',async()=>{const p=await make();const consumer=await f.consumer();const worker=new OutboxWorker(new OutboxRepository(f.catalogPool),{publish:event=>f.publisher.publish(signProducerEvent(event,eventKey))},{},()=>{});await worker.runOnce();await until(async()=>!!await f.elastic.get(await active(),p.id));expect((await f.catalogPool.query('SELECT status FROM outbox_events WHERE aggregate_id=$1',[p.id])).rows[0].status).toBe('PUBLISHED');expect(consumer.counters.consumed).toBe(1);await worker.stop();});
 it('Search cannot connect to the private Catalog database',async()=>{const forbidden=new Pool({connectionString:f.searchUrl.replace('/search_test_db','/catalog_test_db'),connectionTimeoutMillis:1000});try{await expect(forbidden.query('SELECT 1')).rejects.toThrow(/permission denied/);}finally{await forbidden.end();}});
 it('private exports are authenticated, bounded and deterministically ordered',async()=>{await make();const path='/internal/catalog/search-export?mode=state&through=1&limit=1';const response=await fetch(f.catalogOrigin+path,{headers:internalHeaders('GET',path,lookupKey,Date.now(),'search')});expect(response.status).toBe(200);expect((await response.json() as {rows:unknown[]}).rows).toHaveLength(1);const bad=path.replace('limit=1','limit=101');expect((await fetch(f.catalogOrigin+bad,{headers:internalHeaders('GET',bad,lookupKey,Date.now(),'search')})).status).toBe(400);});
});
describe('projection, duplicate and stale-event protection',()=>{
 it('indexes product create',async()=>{const p=await make();await apply(p.id);expect(await f.elastic.get(await active(),p.id)).toMatchObject({name:p.name,productVersion:1,deleted:false});});
 it('indexes product update',async()=>{const p=await make();await apply(p.id);await f.products.update(p.id,{name:'Updated',priceInPaise:5});await apply(p.id);expect(await f.elastic.get(await active(),p.id)).toMatchObject({name:'Updated',priceInPaise:5,productVersion:2});});
 it('indexes a permanent hidden tombstone for delete',async()=>{const p=await make();await apply(p.id);await f.products.delete(p.id);await apply(p.id);expect(await f.elastic.get(await active(),p.id)).toMatchObject({deleted:true,productVersion:2});await refresh();expect((await request(f.app).get('/search/products').expect(200)).body.data).toEqual([]);});
 it.each(['create','update'])('deduplicates repeated %s events without duplicate products',async kind=>{const p=await make();if(kind==='update')await f.products.update(p.id,{priceInPaise:2});const event=await f.event(p.id);await f.projector.consume(event,eventKey);await f.projector.consume(event,eventKey);await refresh();expect((await request(f.app).get('/search/products').expect(200)).body.data).toHaveLength(1);expect((await f.searchPool.query('SELECT count(*) FROM search_receipts')).rows[0].count).toBe('1');});
 it('out-of-order v3,v1,v2 preserves v3',async()=>{const p=await make();const v1=await f.event(p.id);await f.products.update(p.id,{name:'version two'});const v2=await f.event(p.id);await f.products.update(p.id,{name:'version three'});const v3=await f.event(p.id);for(const event of [v3,v1,v2])await f.projector.consume(event,eventKey);expect(await f.elastic.get(await active(),p.id)).toMatchObject({name:'version three',productVersion:3});});
 it('old updates cannot resurrect a tombstone after ordinary delete-retention would expire',async()=>{const p=await make();const old=await f.event(p.id);await f.products.delete(p.id);await apply(p.id);await f.elastic.request('PUT',`/${await active()}/_settings`,{index:{gc_deletes:'0ms'}});await f.projector.consume(old,eventKey);expect((await f.elastic.get(await active(),p.id))?.deleted).toBe(true);});
 it('concurrent consumers cannot roll back a newer version',async()=>{const p=await make();const events:Event[]=[await f.event(p.id)];for(let i=0;i<5;i++){await f.products.update(p.id,{priceInPaise:i});events.push(await f.event(p.id));}await Promise.all([...events.reverse(),...events].map(event=>f.projector.consume(event,eventKey)));expect((await f.elastic.get(await active(),p.id))?.productVersion).toBe(6);});
 it('replaying an old event after loss of a physical index does not auto-create a dynamic index',async()=>{const p=await make();await apply(p.id);const index=await active();await f.elastic.request('DELETE',`/${index}`);await expect(apply(p.id)).rejects.toThrow();expect(await f.elastic.current()).toEqual([]);});
 it('inbox commit failure after Elasticsearch success is recoverable',async()=>{const p=await make();const event=await f.event(p.id);const complete=vi.spyOn(f.repository,'complete').mockRejectedValueOnce(new Error('test commit interruption'));await expect(f.projector.consume(event,eventKey)).rejects.toThrow();expect((await f.elastic.get(await active(),p.id))?.productVersion).toBe(1);expect((await f.searchPool.query('SELECT status FROM search_receipts WHERE event_id=$1',[event.eventId])).rows[0].status).toBe('PENDING');complete.mockRestore();await f.projector.consume(event,eventKey);expect((await f.searchPool.query('SELECT status FROM search_receipts WHERE event_id=$1',[event.eventId])).rows[0].status).toBe('DONE');});
 it.each(['before-index','after-index','before-ack'])('SIGKILL at %s recovers via real RabbitMQ redelivery',async checkpoint=>{const p=await make();const event=await f.event(p.id);const worker=child('consumer',checkpoint);await worker.wait('ready');await f.publisher.publish(event);await worker.wait(checkpoint);worker.process.kill('SIGKILL');await worker.exited;const consumer=await f.consumer();await until(async()=>!!(await f.elastic.get(await active(),p.id))&&consumer.counters.consumed===1);expect((await f.searchPool.query('SELECT count(*) FROM search_receipts WHERE event_id=$1 AND status=\'DONE\'',[event.eventId])).rows[0].count).toBe('1');});
 it.each(['invalid-json','unsupported-version','forged-signature'])('dead-letters %s through real broker topology',async kind=>{const p=await make();const event=await f.event(p.id);await f.consumer();const bad=kind==='invalid-json'?Buffer.from('not JSON'):Buffer.from(JSON.stringify({...event,...(kind==='unsupported-version'?{eventVersion:2}:{signature:'0'.repeat(64)})}));f.channel.publish('commerce.events','catalog.product.created.v1',bad,{persistent:true,contentType:'application/json'});await until(async()=>!!(await f.channel.checkQueue('search.product-events.dlq')).messageCount);const dead=await f.channel.get('search.product-events.dlq',{noAck:false});expect(dead).toBeTruthy();if(dead)f.channel.ack(dead);expect(await f.elastic.get(await active(),p.id)).toBeUndefined();});
});
describe('real Elasticsearch search API',()=>{
 it('matches exact name',async()=>{await seedSearch();expect((await request(f.app).get('/search/products?q=Wireless').expect(200)).body.data.map((p:{name:string})=>p.name)).toEqual(['Wireless Headphones']);});
 it('matches description',async()=>{await seedSearch();expect((await request(f.app).get('/search/products?q=Ceramic').expect(200)).body.data[0].name).toBe('Coffee Mug');});
 it('supports bounded fuzzy typo and prefix matches',async()=>{await seedSearch();expect((await request(f.app).get('/search/products?q=wirless%20headphone').expect(200)).body.data[0].name).toBe('Wireless Headphones');expect((await request(f.app).get('/search/products?q=Wire').expect(200)).body.data[0].name).toBe('Wireless Headphones');});
 it('filters prices in integer minor units',async()=>{await seedSearch();expect((await request(f.app).get('/search/products?minPrice=20000&maxPrice=60000').expect(200)).body.data.map((p:{name:string})=>p.name)).toEqual(['Desk Lamp']);});
 it('filters creation date',async()=>{await seedSearch();expect((await request(f.app).get('/search/products?createdAfter=2099-01-01T00:00:00Z').expect(200)).body.data).toEqual([]);});
 it.each([['price_asc',['Coffee Mug','Desk Lamp','Wireless Headphones']],['price_desc',['Wireless Headphones','Desk Lamp','Coffee Mug']]] as const)('sorts %s stably',async(sort,names)=>{await seedSearch();expect((await request(f.app).get('/search/products').query({sort}).expect(200)).body.data.map((p:{name:string})=>p.name)).toEqual(names);});
 it('weights name relevance above description matches',async()=>{await make('Bluetooth',1,'sound');await make('Other',1,'Bluetooth');for(const p of await f.products.findAll())await apply(p.id);await refresh();expect((await request(f.app).get('/search/products?q=Bluetooth').expect(200)).body.data[0].name).toBe('Bluetooth');});
 it('sorts newest with deterministic ID ties',async()=>{const a=await make('old',1);const b=await make('new',1);await f.catalogPool.query("UPDATE products SET created_at='2020-01-01' WHERE id=$1",[a.id]);await apply(a.id);await apply(b.id);await refresh();expect((await request(f.app).get('/search/products?sort=newest').expect(200)).body.data[0].id).toBe(b.id);});
 it('paginates stable ties with authenticated opaque cursors',async()=>{const ids:string[]=[];for(let i=0;i<5;i++){const p=await make('same',1);ids.push(p.id);await apply(p.id);}await refresh();let cursor:string|null=null;const seen:string[]=[];for(let i=0;i<4;i++){const response:Response=await request(f.app).get('/search/products').query({sort:'price_asc',limit:2,...(cursor?{cursor}:{})}).expect(200);seen.push(...response.body.data.map((p:{id:string})=>p.id));cursor=response.body.pagination.nextCursor;if(!cursor)break;}expect(seen).toEqual(ids.sort());expect(new Set(seen).size).toBe(5);});
 it('returns valid empty search results',async()=>{expect((await request(f.app).get('/search/products?q=none').expect(200)).body).toEqual({data:[],pagination:{limit:20,nextCursor:null}});});
 it.each([{q:'x'.repeat(121)},{minPrice:-1},{minPrice:5,maxPrice:1},{sort:'_script'},{limit:101},{category:'invented'},{query:'{"match_all":{}}'},{cursor:'forged'}])('rejects unsafe public input %o',async query=>{await request(f.app).get('/search/products').query(query).expect(400);});
 it('authoritative Catalog existence suppresses deleted-but-not-yet-indexed products',async()=>{const p=await make();await apply(p.id);await refresh();await f.products.delete(p.id);expect((await f.elastic.get(await active(),p.id))?.deleted).toBe(false);expect((await request(f.app).get('/search/products').expect(200)).body.data).toEqual([]);});
 it('Catalog visibility outage fails closed rather than returning unverified products',async()=>{const p=await make();await apply(p.id);await refresh();vi.spyOn(f.catalog,'visible').mockRejectedValueOnce(new SearchUnavailableError());const response=await request(f.app).get('/search/products');expect(response.status).toBe(503);expect(response.body).not.toHaveProperty('data');});
});
describe('rebuild and reconciliation under concurrent writes',()=>{
 it('fully rebuilds existing products through the private Catalog API',async()=>{await make();await make('second',1);const job=await f.rebuild();expect(job.status).toBe('COMPLETE');expect(await f.elastic.get(job.index_name,(await f.products.findAll())[0]!.id)).toBeDefined();expect((await f.repository.status()).targets.filter(t=>t.status==='RETAINED')).toHaveLength(1);});
 it('concurrent update/delete/create and older snapshot replay cannot lose committed changes',async()=>{const p=await make(),deleted=await make('delete',1);const old=(await f.event(p.id)).payload as {product:Parameters<typeof f.projector.write>[0]};const job=await f.repository.createJob('REBUILD',randomUUID());await f.coordinator.step(job.id);await f.coordinator.step(job.id);await f.products.update(p.id,{name:'newest'});await f.products.update(p.id,{priceInPaise:9});await f.products.delete(deleted.id);const created=await make('created during rebuild',4);await apply(p.id);await apply(deleted.id);await apply(created.id);await f.projector.write(old.product,[job.index_name]);await f.coordinator.runToCompletion(job.id);expect(await f.elastic.get(job.index_name,p.id)).toMatchObject({name:'newest',priceInPaise:9,productVersion:3});expect((await f.elastic.get(job.index_name,deleted.id))?.deleted).toBe(true);expect(await f.elastic.get(job.index_name,created.id)).toBeDefined();});
 it('captures committed changes through catch-up even when RabbitMQ deliveries are delayed',async()=>{const p=await make();const job=await f.repository.createJob('REBUILD',randomUUID());await f.coordinator.step(job.id);await f.products.update(p.id,{name:'delayed event latest'});const created=await make('delayed created',1);await f.coordinator.runToCompletion(job.id);expect((await f.elastic.get(job.index_name,p.id))?.name).toBe('delayed event latest');expect(await f.elastic.get(job.index_name,created.id)).toBeDefined();});
 it('continues serving the old alias during a candidate rebuild and switches atomically',async()=>{await seedSearch();const previous=await active(),job=await f.repository.createJob('REBUILD',randomUUID());await f.coordinator.step(job.id);await request(f.app).get('/search/products').expect(200);expect(await f.elastic.current()).toEqual([previous]);await f.coordinator.runToCompletion(job.id);expect(await f.elastic.current()).toEqual([job.index_name]);expect((await f.elastic.request('GET',`/${previous}/_mapping`))).toHaveProperty(previous);});
 it.each(['before-alias','after-alias'])('SIGKILL %s resumes durable rebuild and retains old index',async checkpoint=>{await make();const previous=await active(),job=await f.repository.createJob('REBUILD',randomUUID());const worker=child('rebuild',checkpoint,job.id);await worker.wait(checkpoint,15000);worker.process.kill('SIGKILL');await worker.exited;await f.coordinator.runToCompletion(job.id);expect((await f.repository.job(job.id))?.status).toBe('COMPLETE');expect(await f.elastic.current()).toEqual([job.index_name]);expect((await f.elastic.request('GET',`/${previous}/_mapping`))).toHaveProperty(previous);},20000);
 it('reconciliation detects and repairs missing and stale projections',async()=>{const p=await make();await apply(p.id);await f.products.update(p.id,{name:'not delivered yet'});const missing=await make('missing',1);const job=await f.repository.createJob('RECONCILE',randomUUID());await f.coordinator.runToCompletion(job.id);expect(Number((await f.repository.job(job.id))?.mismatches)).toBe(2);expect((await f.elastic.get(await active(),p.id))?.name).toBe('not delivered yet');expect(await f.elastic.get(await active(),missing.id)).toBeDefined();});
 it('reconciliation repairs wrongly visible deleted products from durable authoritative tombstones',async()=>{const p=await make();await apply(p.id);await f.products.delete(p.id);const job=await f.repository.createJob('RECONCILE',randomUUID());await f.coordinator.runToCompletion(job.id);expect((await f.elastic.get(await active(),p.id))?.deleted).toBe(true);expect(Number((await f.repository.job(job.id))?.mismatches)).toBe(1);});
 it('does not create duplicate concurrent rebuilds',async()=>{const results=await Promise.allSettled([f.repository.createJob('REBUILD',randomUUID()),f.repository.createJob('REBUILD',randomUUID())]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);});
 it('export interruption leaves resumable progress and the public alias unchanged',async()=>{const previous=await active();await make();const job=await f.repository.createJob('REBUILD',randomUUID());await f.coordinator.step(job.id);vi.spyOn(f.catalog,'export').mockRejectedValueOnce(new Error('interrupted export'));expect(await f.coordinator.step(job.id)).toBe(false);expect(await f.elastic.current()).toEqual([previous]);await f.searchPool.query('UPDATE search_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1',[job.id]);await f.coordinator.runToCompletion(job.id);expect((await f.repository.job(job.id))?.status).toBe('COMPLETE');});
});
describe('authorization, opt-in Gateway and telemetry',()=>{
 it.each(['missing','customer','invalid'])('rejects %s rebuild authorization',async kind=>{const call=request(f.app).post('/admin/search/rebuild').send({});if(kind!=='missing')call.set('Authorization',kind==='customer'?`Bearer ${await f.jwt.sign('customer')}`:'Bearer invalid');await call.expect(kind==='customer'?403:401);});
 it('admin can start and inspect an audited rebuild, but cannot select arbitrary index names',async()=>{const token=await f.jwt.sign();const bad=await request(f.app).post('/admin/search/rebuild').set('Authorization',`Bearer ${token}`).send({index:'other_project'}).expect(400);expect(bad.body).not.toHaveProperty('id');const response=await request(f.app).post('/admin/search/rebuild').set('Authorization',`Bearer ${token}`).send({}).expect(202);await request(f.app).get(`/admin/search/rebuild/${response.body.id}`).set('Authorization',`Bearer ${token}`).expect(200);expect((await f.searchPool.query('SELECT operation FROM search_audit')).rows.map(row=>row.operation)).toContain('REBUILD');});
 it.each(['missing','forged','wrong-caller'])('rejects %s internal export identity',async kind=>{const path='/internal/catalog/search-export?through=0';const headers=kind==='wrong-caller'?internalHeaders('GET',path,lookupKey):kind==='forged'?{'x-service-name':'search','x-service-time':String(Math.floor(Date.now()/1000)),'x-service-signature':'0'.repeat(64)}:{};expect((await fetch(f.catalogOrigin+path,{headers})).status).toBe(401);});
 it('never routes private exports publicly through Gateway',async()=>{const app=gatewayApp({CATALOG_SERVICE_URL:f.catalogOrigin,CATALOG_REQUEST_TIMEOUT_MS:1000},undefined,{enabled:true,url:f.catalogOrigin,timeoutMs:1000});await request(app).get('/internal/catalog/search-export?through=0').expect(404);});
 it('disabled Search and Gateway flags preserve existing routes without making Elasticsearch mandatory',async()=>{const disabled=createApp({enabled:false,rebuildEnabled:false,defaultLimit:20,maxLimit:100,cursorKey:'',elastic:new Elasticsearch('http://127.0.0.1:1',f.alias,20),catalog:f.catalog,repository:f.repository,verify:f.jwt.verify});await request(disabled).get('/search/products').expect(404);await request(disabled).get('/health').expect(200);await request(disabled).get('/ready').expect(200);await request(gatewayApp({CATALOG_SERVICE_URL:f.catalogOrigin,CATALOG_REQUEST_TIMEOUT_MS:1000})).get('/search/products').expect(404);});
 it('Gateway forwards search query parameters with rate limiting disabled',async()=>{await seedSearch();const server=createServer(f.app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));const app=gatewayApp({CATALOG_SERVICE_URL:f.catalogOrigin,CATALOG_REQUEST_TIMEOUT_MS:1000},undefined,{enabled:true,url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,timeoutMs:2000});expect((await request(app).get('/search/products?q=Wireless').expect(200)).body.data[0].name).toBe('Wireless Headphones');});
 it('uses the existing atomic Redis SEARCH policy when enabled',async()=>{const store=new RedisRateLimitStore({url:rateRedis.url,connectTimeoutMs:1000,commandTimeoutMs:500,maxPending:10});cleanup.push(()=>store.close());expect(await store.start()).toBe(true);const limiter=new DistributedRateLimiter(store,`ecommerce:v2:ratelimit:v1:test-${randomUUID()}`,{...defaultPolicies,SEARCH:{capacity:1,refillTokens:1,windowMs:60000}});const app=gatewayApp({CATALOG_SERVICE_URL:f.catalogOrigin,CATALOG_REQUEST_TIMEOUT_MS:1000},{limiter,verify:f.jwt.verify,trustedProxies:[],failOpenPublic:true,log:()=>{}},{enabled:true,url:await (()=>new Promise<string>(resolve=>{const server=createServer(f.app);server.listen(0,'127.0.0.1',()=>{cleanup.push(()=>new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections();}));resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);});}))(),timeoutMs:2000});await request(app).get('/search/products').expect(200);await request(app).get('/search/products').expect(429);});
 it('metrics have no product/customer IDs or raw queries as labels and indexing logs contain no tokens',async()=>{const p=await make();await apply(p.id);const serialized=JSON.stringify(f.projector.metrics.snapshot());expect(serialized).not.toContain(p.id);expect(serialized).not.toContain(eventKey);expect(JSON.stringify(f.logs)).not.toContain(eventKey);expect(f.logs.at(-1)).toMatchObject({productId:p.id,productVersion:1,outcome:'indexed'});});
});


describe('operator rollback, cleanup and unexpected projection audits',()=>{
 it('catches up a retained index before an authenticated rollback and retains its replacement',async()=>{
  const p=await make();await apply(p.id);const prior=(await f.searchPool.query("SELECT id FROM search_jobs WHERE kind='REBUILD' AND status='COMPLETE' ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
  await f.rebuild();await f.products.update(p.id,{name:'after replacement'});
  const token=await f.jwt.sign();const response=await request(f.app).post(`/admin/search/rollback/${prior}`).set('Authorization',`Bearer ${token}`).send({}).expect(202);
  await f.coordinator.runToCompletion(response.body.id);const job=(await f.repository.job(response.body.id))!;
  expect(await f.elastic.current()).toEqual([job.index_name]);expect((await f.elastic.get(job.index_name,p.id))?.name).toBe('after replacement');
 });
 it('allows explicit admin cleanup only for an owned retained generation',async()=>{
  const prior=(await f.searchPool.query("SELECT id,index_name FROM search_jobs WHERE kind='REBUILD' AND status='COMPLETE' ORDER BY created_at DESC LIMIT 1")).rows[0];const current=await f.rebuild();const token=await f.jwt.sign();
  await request(f.app).delete(`/admin/search/retained/${current.id}`).set('Authorization',`Bearer ${token}`).expect(409);
  await request(f.app).delete(`/admin/search/retained/${prior.id}`).set('Authorization',`Bearer ${await f.jwt.sign('customer')}`).expect(403);
  await request(f.app).delete(`/admin/search/retained/${prior.id}`).set('Authorization',`Bearer ${token}`).expect(204);
  expect((await f.repository.targets())).not.toContain(prior.index_name);expect(await f.elastic.current()).toEqual([current.index_name]);
 });
 it('detects unknown indexed documents and reports the mismatch without silently deleting them',async()=>{
  const index=await active(),id=randomUUID(),time=new Date().toISOString();await f.elastic.put(index,{id,productVersion:1,name:'unknown',description:'',priceInPaise:1,createdAt:time,updatedAt:time,deleted:false});
  const job=await f.repository.createJob('RECONCILE',randomUUID());await f.coordinator.runToCompletion(job.id);
  expect(Number((await f.repository.job(job.id))?.unresolved)).toBe(1);expect(await f.elastic.get(index,id)).toBeDefined();
  expect((await request(f.app).get('/search/products').expect(200)).body.data).toEqual([]);
 });
});


describe('real Elasticsearch and broker failure injection',()=>{
 it('Elasticsearch unavailable at startup reports degraded and never returns a misleading empty page',async()=>{
  const elastic=new Elasticsearch('http://127.0.0.1:1',f.alias,50);expect(await elastic.ready()).toBe(false);
  const app=createApp({enabled:true,rebuildEnabled:true,defaultLimit:20,maxLimit:100,cursorKey,elastic,catalog:f.catalog,repository:f.repository,verify:f.jwt.verify});
  await request(app).get('/health').expect(200);await request(app).get('/ready').expect(503);
  const response=await request(app).get('/search/products').expect(503);expect(response.body.error.code).toBe('SEARCH_UNAVAILABLE');expect(response.body).not.toHaveProperty('data');
 });
 it('transient Elasticsearch rejection preserves committed Catalog changes and retries through real RabbitMQ',async()=>{
  const proxy=await elasticProxy(f.elasticOrigin);cleanup.push(()=>proxy.close());proxy.fail(503);
  const projector=new Projector(f.repository,new Elasticsearch(proxy.origin,f.alias,100));
  const consumer=await f.consumer(event=>projector.consume(event,eventKey));const p=await make();await f.publisher.publish(await f.event(p.id));
  await until(()=>consumer.counters.retried>0);expect(await f.products.findById(p.id)).toBeDefined();
  proxy.fail();await until(async()=>consumer.counters.consumed===1&&!!await f.elastic.get(await active(),p.id));
  expect((await f.searchPool.query('SELECT status FROM search_receipts')).rows[0].status).toBe('DONE');
 });
 it('lost Elasticsearch reply times out within the command budget and recovers without rollback or duplicate documents',async()=>{
  const proxy=await elasticProxy(f.elasticOrigin);cleanup.push(()=>proxy.close());const projector=new Projector(f.repository,new Elasticsearch(proxy.origin,f.alias,80));
  const p=await make();const event=await f.event(p.id);proxy.pause();const began=performance.now();const pending=projector.consume(event,eventKey).catch(error=>error);
  await proxy.captured();expect((await pending).code).toBe('ELASTICSEARCH_TIMEOUT');expect(performance.now()-began).toBeLessThan(1000);
  expect(await f.elastic.get(await active(),p.id)).toBeDefined();proxy.release();const recovery=new Projector(f.repository,new Elasticsearch(proxy.origin,f.alias,2000));await recovery.consume(event,eventKey);
  expect((await f.searchPool.query('SELECT count(*) FROM search_projection_state')).rows[0].count).toBe('1');
 });
 it('real Elasticsearch mapping rejection is permanent, not retried forever',async()=>{
  const index=f.alias+'_invalid',time=new Date().toISOString();await f.elastic.request('PUT',`/${index}`,{mappings:{dynamic:'strict',properties:{id:{type:'keyword'},productVersion:{type:'long'},name:{type:'text'},description:{type:'text'},priceInPaise:{type:'object'},createdAt:{type:'date'},updatedAt:{type:'date'},deleted:{type:'boolean'}}},aliases:{[index+'_write']:{is_write_index:true}}});
  cleanup.push(()=>f.elastic.request('DELETE',`/${index}`,undefined,[404]));
  await expect(f.elastic.put(index,{id:randomUUID(),productVersion:1,name:'invalid',description:'',priceInPaise:1,createdAt:time,updatedAt:time,deleted:false})).rejects.toBeInstanceOf(InvalidProjectionError);
 });
 it('actual RabbitMQ TCP disconnect recovers an unacknowledged event',async()=>{
  const proxy=await redisProxy(f.brokerPort);cleanup.push(()=>proxy.close());const url=new URL(f.brokerUrl);url.port=String(proxy.port);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),claimed=new Promise<void>(resolve=>{entered=resolve;});let first=true;
  const consumer=await f.consumer(async event=>{if(first){first=false;entered();await gate;}await f.projector.consume(event,eventKey);},url.toString());
  const p=await make();await f.publisher.publish(await f.event(p.id));await claimed;await proxy.disconnect();release();await proxy.recover();
  await until(()=>consumer.status==='ready'&&consumer.counters.consumed===1);expect(await f.elastic.get(await active(),p.id)).toBeDefined();
 });
 it('real PostgreSQL source export interruption leaves resumable progress',async()=>{
  await make();const job=await f.repository.createJob('REBUILD',randomUUID());await f.coordinator.step(job.id);
  await f.catalogPool.query('ALTER TABLE catalog_search_documents RENAME TO temporarily_unavailable_search_documents');
  try{expect(await f.coordinator.step(job.id)).toBe(false);expect((await f.repository.job(job.id))?.status).toBe('SNAPSHOT');}
  finally{await f.catalogPool.query('ALTER TABLE temporarily_unavailable_search_documents RENAME TO catalog_search_documents');}
  await f.searchPool.query('UPDATE search_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1',[job.id]);await f.coordinator.runToCompletion(job.id);expect((await f.repository.job(job.id))?.status).toBe('COMPLETE');
 });
});

 it('least-privilege Search credentials cannot configure or read another service queue',async()=>{
  const user='restricted_search_'+randomUUID().slice(0,8),password='isolated_restricted_search_only';
  await f.management('users/'+user,'PUT',{password,tags:''});const owned='^(commerce\\.search\\.handoff|search\\..*)$';
  await f.management('permissions/search_test/'+user,'PUT',{configure:owned,write:owned,read:'^(commerce\\.events|commerce\\.search\\.handoff|search\\..*)$'});
  await f.management('topic-permissions/search_test/'+user,'PUT',{exchange:'commerce.events',write:'(?!)',read:'^catalog\\.product\\.(created|updated|deleted)\\.v1$'});
  const url=new URL(f.brokerUrl);url.username=user;url.password=password;const consumer=await f.consumer(undefined,url.toString());expect(consumer.status).toBe('ready');
  await f.channel.assertQueue('orders.test-only.v1',{durable:false});const connection=await amqp.connect(url.toString());connection.on('error',()=>{});cleanup.push(()=>connection.close().catch(()=>{}));
  const configure=await connection.createChannel();configure.on('error',()=>{});await expect(configure.assertQueue('orders.forbidden.v1')).rejects.toMatchObject({code:403});
  const read=await connection.createChannel();read.on('error',()=>{});await expect(read.get('orders.test-only.v1',{noAck:false})).rejects.toMatchObject({fields:{replyCode:403}});
  await f.channel.deleteQueue('orders.test-only.v1');
 });

});
