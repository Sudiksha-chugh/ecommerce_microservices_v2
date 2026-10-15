import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {appendFileSync} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { OwnedSearchIndexes } from './owned-indexes.js';
import { setupDiagnostics, observePool, errorCode } from './setup-diagnostics.js';
import amqp from 'amqplib';
import { migrate as catalogMigrate } from '../../catalog-service/src/db/migrate.js';
import { migrate } from '../src/migrate.js';
import { ProductRepository } from '../../catalog-service/src/product-repository.js';
import { CatalogSearchSource } from '../../catalog-service/src/search-source.js';
import { createApp as catalogApp } from '../../catalog-service/src/app.js';
import { createJwtFixture } from '../../../test/jwt-fixture.js';
import { CatalogClient } from '../src/catalog-client.js';
import { Elasticsearch,SearchUnavailableError } from '../src/elasticsearch.js';
import { SearchRepository } from '../src/repository.js';
import { Projector } from '../src/projector.js';
import { RebuildCoordinator } from '../src/rebuild.js';
import { createApp } from '../src/app.js';
import { querySchema, searchBody } from '../src/query.js';
import { signProducerEvent, validateEvent, Messaging, type Event, declareTopology } from '@ecommerce/messaging';
const exec=promisify(execFile);
export const eventKey='test-catalog-producer-key-xxxxxxxxxxxxxxxx';
export const lookupKey='test-search-lookup-key-xxxxxxxxxxxxxxxxxx';
export const cursorKey='test-search-cursor-key-xxxxxxxxxxxxxxxxxx';
export async function searchFixture(){
 const embedded=process.env.INTEGRATION_SEARCH_STORES==='true';
 if(embedded&&!process.env.INTEGRATION_ENV_DIR)throw new Error('Search store namespace requires the isolated integration runner');
 const supplied=process.env.SEARCH_TEST_PROJECT;
 if(supplied&&supplied!=='commerce-v2-phase16-probe'&&!/^commerce-v2-search-test-[a-f0-9]{8}$/.test(supplied))throw new Error('Unsafe Search test project override');
 const project=supplied??`commerce-v2-search-test-${randomUUID().slice(0,8)}`;const base=['compose','-p',project,'-f','compose.search-test.yaml'];
 const docker=(args:string[])=>{if(embedded)throw new Error('Docker control is unavailable inside the isolated test runner');return exec('docker',[...base,...args],{timeout:120000,maxBuffer:100000});};
 const port=async(service:string,internal:number)=>Number((await docker(['port',service,String(internal)])).stdout.trim().split(':').at(-1));
 const stage=async(name:string)=>{const {writeFile}=await import('node:fs/promises');await writeFile(`/tmp/${project}-stage.json`,JSON.stringify({project,stage:name,time:new Date().toISOString(),monotonicMs:performance.now(),rssBytes:process.memoryUsage().rss}));console.info(JSON.stringify({component:'search-test',project,stage:name}));};
 const diagnostic=(operation:string,values:Record<string,unknown>)=>{const row={at:new Date().toISOString(),monotonicMs:performance.now(),pid:process.pid,operation,...values};if(process.env.INTEGRATION_DIAGNOSTICS_FILE)appendFileSync(process.env.INTEGRATION_DIAGNOSTICS_FILE,JSON.stringify(row)+'\n');};
 const measured=async<T>(name:string,action:()=>Promise<T>)=>{const start=performance.now();try{return await action();}finally{diagnostic(name,{durationMs:performance.now()-start});}};
 const pools:Pool[]=[];const servers:Server[]=[];const managers:Messaging[]=[];const brokerClosers:(()=>Promise<unknown>)[]=[];const pendingWork=new Set<Promise<unknown>>();
 let ownedIndexes:OwnedSearchIndexes|undefined,ownedElastic:Elasticsearch|undefined;
 const setup=setupDiagnostics(()=>({pendingWork:pendingWork.size,pools:pools.map(pool=>({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount})),managers:managers.map(manager=>({status:manager.status,counters:manager.counters}))}));
 const setupStage=setup.stage;
 const track=<T>(work:Promise<T>)=>{pendingWork.add(work);void work.then(()=>pendingWork.delete(work),()=>pendingWork.delete(work));return work;};
 const teardownStage=async(name:string,action:()=>Promise<unknown>)=>{
  const started=performance.now();const outstanding=()=>({pendingWork:pendingWork.size,pools:pools.map(pool=>({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount})),managers:managers.map(manager=>({status:manager.status,counters:manager.counters}))});
  diagnostic(name,{stage:'BEGIN',...outstanding()});
  try{await action();diagnostic(name,{stage:'END',durationMs:performance.now()-started,outcome:'ok',...outstanding()});}
  catch(error){diagnostic(name,{stage:'END',durationMs:performance.now()-started,outcome:'failed',code:error instanceof Error?error.name:'ERROR',...outstanding()});throw error;}
 };
 const close=async()=>{
  diagnostic('SEARCH_TEARDOWN',{stage:'BEGIN'});
  // Protocol dependencies: close the setup channel before its connection;
  // stop managers before draining projection/rebuild work or closing their pools.
  for(const [index,closeBroker] of brokerClosers.splice(0).reverse().entries())await teardownStage(index===0?'CLOSE_RAW_CHANNEL':'CLOSE_RAW_CONNECTION',closeBroker);
  for(const manager of managers)await teardownStage('STOP_MESSAGING_MANAGER',()=>manager.stop());
  await teardownStage('DRAIN_PROJECTION_REBUILD',async()=>{const results=await Promise.allSettled([...pendingWork]);diagnostic('DRAIN_RESULTS',{rejected:results.filter(result=>result.status==='rejected').length});});
  for(const server of servers)await teardownStage('CLOSE_CATALOG_HTTP',()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
  if(ownedIndexes&&ownedElastic)await teardownStage('CLEANUP_OWNED_INDEXES',()=>ownedIndexes!.cleanup(ownedElastic!,async()=>{await Promise.allSettled([...pendingWork]);}));
  for(const pool of pools)await teardownStage('CLOSE_POSTGRES_POOL',()=>pool.end());
  if(!embedded&&process.env.SEARCH_TEST_KEEP_STORES!=='true')await teardownStage('CLEANUP_OWNED_STORES',()=>docker(['down','--remove-orphans']));
  diagnostic('SEARCH_TEARDOWN',{stage:'COMPLETE'});
 };
 setup.emit('SEARCH_SETUP',{stage:'BEGIN',project,embedded});
 try{
  const embeddedPorts=embedded?(await import('node:util')).parseEnv(await (await import('node:fs/promises')).readFile((await import('node:path')).join(process.env.INTEGRATION_ENV_DIR!,'.env.search-test'),'utf8')):{};
  console.info(JSON.stringify({component:'search-test',project,stage:'starting_stores'}));if(!embedded)await setupStage('START_OWNED_STORES','docker',()=>docker(['up','-d','--wait','--wait-timeout','60']));console.info(JSON.stringify({component:'search-test',project,stage:'stores_ready',embedded}));const pgPort=embedded?Number(embeddedPorts.PGPORT):await port('postgres',5432),brokerPort=embedded?Number(embeddedPorts.AMQP_PORT):await port('rabbitmq',5672),managementPort=embedded?Number(embeddedPorts.MANAGEMENT_PORT):await port('rabbitmq',15672),elasticPort=embedded?Number(embeddedPorts.ELASTIC_PORT):await port('elasticsearch',9200);
  const admin=new Pool({host:'127.0.0.1',port:pgPort,user:'search_test_admin',password:'isolated_search_only',database:'postgres',max:2,connectionTimeoutMillis:2000,statement_timeout:5000,query_timeout:5000});pools.push(admin);observePool(admin,'admin',setup.emit);
  const identity=(await setupStage('POSTGRES_ADMIN_READY','postgres',()=>admin.query('SELECT current_database() AS db,current_user AS role'))).rows[0];if(identity.db!=='postgres'||identity.role!=='search_test_admin')throw new Error('Unsafe Search fixture database identity');
  // Only this purpose-owned tmpfs cluster has these fixed test databases/roles.
  await setupStage('PROVISION_OWNED_DATABASES','postgres',async()=>{
  await admin.query('DROP DATABASE IF EXISTS catalog_test_db WITH (FORCE)');await admin.query('DROP DATABASE IF EXISTS search_test_db WITH (FORCE)');await admin.query('DROP ROLE IF EXISTS catalog_search_test');await admin.query('DROP ROLE IF EXISTS search_projection_test');
  await admin.query("CREATE ROLE catalog_search_test LOGIN PASSWORD 'isolated_catalog_only'");await admin.query("CREATE ROLE search_projection_test LOGIN PASSWORD 'isolated_projection_only'");
  await admin.query('CREATE DATABASE catalog_test_db OWNER catalog_search_test');await admin.query('CREATE DATABASE search_test_db OWNER search_projection_test');
  await admin.query('REVOKE CONNECT ON DATABASE catalog_test_db FROM PUBLIC');await admin.query('REVOKE CONNECT ON DATABASE search_test_db FROM PUBLIC');});await stage('databases_provisioned');
  const catalogUrl=`postgresql://catalog_search_test:isolated_catalog_only@127.0.0.1:${pgPort}/catalog_test_db`,searchUrl=`postgresql://search_projection_test:isolated_projection_only@127.0.0.1:${pgPort}/search_test_db`;
  const catalogPool=new Pool({connectionString:catalogUrl,max:8,statement_timeout:5000,connectionTimeoutMillis:2000}),searchPool=new Pool({connectionString:searchUrl,max:10,statement_timeout:5000,connectionTimeoutMillis:2000});pools.push(catalogPool,searchPool);observePool(catalogPool,'catalog',setup.emit);observePool(searchPool,'search',setup.emit);
  catalogPool.on('error',()=>{});searchPool.on('error',()=>{});await setupStage('CATALOG_MIGRATIONS','postgres',()=>catalogMigrate(catalogPool));await setupStage('SEARCH_MIGRATIONS','postgres',()=>migrate(searchPool));
  await setupStage('SEARCH_SCHEMA_READY','postgres',async()=>{const row=(await searchPool.query("SELECT to_regclass('public.search_jobs') IS NOT NULL AS jobs,to_regclass('public.search_targets') IS NOT NULL AS targets,(SELECT count(*)::int FROM schema_migrations) AS migrations")).rows[0];if(!row.jobs||!row.targets||row.migrations!==1)throw new Error('Search schema readiness failed');});await stage('schemas_migrated');
  const jwt=await createJwtFixture();const products=new ProductRepository(catalogPool);const source=new CatalogSearchSource(catalogPool);
  const listen=async(app:ReturnType<typeof catalogApp>)=>{const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;};
  const catalogOrigin=await setupStage('CATALOG_HTTP_START','http',()=>listen(catalogApp(products,jwt.verify,source,lookupKey)));
  const elasticOrigin=`http://127.0.0.1:${elasticPort}`,alias=`commerce_v2_products_test_${randomUUID().replaceAll('-','').slice(0,12)}`;
  const elastic=new Elasticsearch(elasticOrigin,alias,2000),repository=new SearchRepository(searchPool,alias),catalog=new CatalogClient(catalogOrigin,lookupKey),logs:Record<string,unknown>[]=[];
  const indexes=new OwnedSearchIndexes(alias);ownedIndexes=indexes;ownedElastic=elastic;
  const createJob=repository.createJob.bind(repository);repository.createJob=(...args:Parameters<SearchRepository['createJob']>)=>track(createJob(...args).then(job=>{if(job.kind!=='RECONCILE')indexes.created(job.index_name);return job;}));
  const send=elastic.request.bind(elastic);let measuredRequests=0;
  elastic.request=async<T=Record<string,unknown>>(...args:Parameters<Elasticsearch['request']>):Promise<T>=>{
   const start=performance.now(),record=measuredRequests++<200,indexPath=args[1].match(/^\/([a-z0-9_]+)$/)?.[1];
   if(args[0]==='PUT'&&indexPath)indexes.created(indexPath);
   const kind=args[1].includes('_doc')?'document':args[1].includes('_mapping')?'mapping':args[1].includes('_refresh')?'refresh':args[1].includes('_search')?'search':args[1].includes('_aliases')?'alias_swap':args[1].includes('_alias/')?'alias_read':args[0]==='DELETE'?'index_delete':args[0]==='PUT'?'index_create':'metadata';
   let outcome='ok';if(record)setup.emit('ELASTIC_OPERATION',{stage:'BEGIN',dependency:'elasticsearch',method:args[0],kind});
   try{const result=await send<T>(...args);if(args[0]==='DELETE'&&indexPath)indexes.deleted(indexPath);return result;}catch(error){outcome=errorCode(error);throw error;}
   finally{if(record){setup.emit('ELASTIC_OPERATION',{stage:'END',dependency:'elasticsearch',durationMs:performance.now()-start,method:args[0],kind,outcome:outcome==='ok'?'ok':'failed',...(outcome==='ok'?{}:{code:outcome})});diagnostic('fixture_elasticsearch',{durationMs:performance.now()-start,method:args[0],kind,outcome});}}
  };
  await setupStage('CATALOG_SOURCE_READY','catalog-http',()=>catalog.watermark());
  const projector=new Projector(repository,elastic,undefined,record=>logs.push(record)),coordinator=new RebuildCoordinator(repository,projector,catalog,2);
  const consume=projector.consume.bind(projector),write=projector.write.bind(projector),step=coordinator.step.bind(coordinator),complete=coordinator.runToCompletion.bind(coordinator);
  projector.consume=(...args:Parameters<Projector['consume']>)=>track(consume(...args));projector.write=(...args:Parameters<Projector['write']>)=>track(write(...args));
  coordinator.step=(...args:Parameters<RebuildCoordinator['step']>)=>track(step(...args));coordinator.runToCompletion=(...args:Parameters<RebuildCoordinator['runToCompletion']>)=>track(complete(...args));
  const app=createApp({enabled:true,rebuildEnabled:true,defaultLimit:20,maxLimit:100,cursorKey,elastic,catalog,repository,verify:jwt.verify,metrics:projector.metrics});
  const brokerUrl=`amqp://search_test_broker:isolated_search_broker_only@127.0.0.1:${brokerPort}/search_test`;
  const managementOrigin=`http://127.0.0.1:${managementPort}`,managementAuth='Basic '+Buffer.from('search_test_broker:isolated_search_broker_only').toString('base64');
  const management=async(path:string,method='GET',body?:unknown)=>{const response=await fetch(managementOrigin+'/api/'+path,{method,signal:AbortSignal.timeout(2000),headers:{Authorization:managementAuth,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error('Isolated broker management failed');return response.status===204||response.headers.get('content-length')==='0'?{}:await response.json();};
  await setupStage('RABBIT_MANAGEMENT_READY','rabbitmq',()=>until(async()=>{try{await management('overview');return true;}catch{return false;}},10000));
  const raw=await setupStage('RABBIT_AMQP_READY','rabbitmq',()=>amqp.connect(brokerUrl,{timeout:2000}));raw.on('error',()=>{});brokerClosers.push(()=>raw.close());const channel=await raw.createChannel();brokerClosers.push(()=>channel.close());await setupStage('BROKER_TOPOLOGY_READY','rabbitmq',async()=>{await channel.assertExchange('commerce.events','topic',{durable:true});await declareTopology(channel,'',['search'],[20,40,80]);await channel.checkQueue('search.product-events.v1');});
  const publisher=new Messaging({url:brokerUrl,queues:['search.product-events.v1']},['catalog'],record=>diagnostic('publisher_lifecycle',record));managers.push(publisher);publisher.start();await setupStage('PUBLISHER_READY','rabbitmq',()=>until(()=>publisher.status==='ready'));await stage('broker_publisher_ready');
  const consumers:Messaging[]=[];
  const activeHandlers=new Set<Promise<void>>();
  const quiesce=async()=>{await Promise.all(consumers.splice(0).map(manager=>manager.stop()));await Promise.allSettled([...activeHandlers,...pendingWork]);};
  const consumer=async(handler?:(event:Event)=>Promise<void>,url=brokerUrl)=>{const manager=new Messaging({url,queues:['search.product-events.v1'],retryDelays:[20,40,80],prefetch:5},['search'],record=>diagnostic('consumer_lifecycle',record));manager.register('search.product-events.v1',(event,context)=>{const work=Promise.resolve().then(()=>handler?handler(event):projector.consume(event,eventKey,context.retryCount));activeHandlers.add(work);return work.finally(()=>activeHandlers.delete(work));});managers.push(manager);consumers.push(manager);manager.start();await setupStage('CONSUMER_READY','rabbitmq',()=>until(()=>manager.status==='ready'));return manager;};
  const event=async(id:string)=>{const row=(await catalogPool.query('SELECT envelope FROM outbox_events WHERE aggregate_id=$1 ORDER BY (payload->>\'productVersion\')::bigint DESC LIMIT 1',[id])).rows[0];return signProducerEvent(validateEvent(row.envelope),eventKey);};
  const rebuild=async()=>{const job=await setupStage('REBUILD_JOB_CREATE','postgres',()=>repository.createJob('REBUILD','00000000-0000-4000-8000-000000000000'));
   // Drive the actual durable backoff/recovery lifecycle, as the production poll worker does.
   await setupStage('REBUILD_PHASES','postgres-http-elasticsearch',()=>until(async()=>{await coordinator.step(job.id);const current=await repository.job(job.id);if(current?.status==='PAUSED')throw new Error('Fixture rebuild requires review');return current?.status==='COMPLETE';},10000));
   return (await repository.job(job.id))!;};
  // Functional preflight, not just an HTTP root/cluster health check. Warm the node's real
  // mapping/index/search path with an owned disposable document and the SAME 2s command budget.
  const warmIndex=`${alias}_warm`,warmId=randomUUID(),time=new Date().toISOString();
  let warmError:unknown;
  await setupStage('ELASTIC_FUNCTIONAL_READY','elasticsearch',()=>until(async()=>{try{await elastic.create(warmIndex);await elastic.put(warmIndex,{id:warmId,productVersion:1,name:'Warm fixture',description:'Fixture only',priceInPaise:1,createdAt:time,updatedAt:time,deleted:false});await elastic.refresh(warmIndex);const result=await elastic.request<{timed_out:boolean;hits:{hits:{_source:{id:string}}[]}}>('POST',`/${warmIndex}/_search?allow_partial_search_results=false`,searchBody(querySchema.parse({q:'Warm',limit:20})));if(result.timed_out||result.hits.hits.length!==1||result.hits.hits[0]?._source.id!==warmId)throw new SearchUnavailableError('ELASTICSEARCH_PROBE_INCOMPLETE');return true;}catch(error){warmError=error;return false;}},20000).catch(error=>{throw warmError??error;}));
  await elastic.request('DELETE',`/${warmIndex}`);await stage('functional_elasticsearch_ready');
  const initial=await setupStage('SEARCH_INITIAL_REBUILD','postgres-http-elasticsearch',rebuild);await stage('initial_projection_ready');
  setup.emit('SEARCH_SETUP',{stage:'COMPLETE',project,alias});
  return {setupStage,project,docker,pgPort,brokerPort,managementPort,elasticPort,admin,catalogPool,searchPool,catalogUrl,searchUrl,products,source,jwt,catalogOrigin,elasticOrigin,elastic,alias,repository,catalog,projector,coordinator,logs,app,brokerUrl,channel,management,consumer,consumers,quiesce,publisher,event,rebuild,initial,
   close};
 }catch(error){
  setup.emit('SEARCH_SETUP',{stage:'FAILED',code:errorCode(error)});
  try{if(pools[0])setup.emit('POSTGRES_FAILURE_STATE',{rows:(await pools[0].query("SELECT datname,state,wait_event_type,count(*)::int AS connections FROM pg_stat_activity WHERE backend_type='client backend' GROUP BY datname,state,wait_event_type")).rows});}catch(diagnosticError){setup.emit('POSTGRES_FAILURE_STATE',{code:errorCode(diagnosticError)});}
  diagnostic('fixture_setup_failed',{code:error instanceof Error?error.name:'ERROR',message:error instanceof Error?error.message:'Setup failed'});
  try{const {writeFile}=await import('node:fs/promises');if(pools[2])await writeFile(`/tmp/${project}-jobs.json`,JSON.stringify((await pools[2].query('SELECT id,status,initial_watermark,retries,last_error FROM search_jobs')).rows));const logs=await docker(['logs','--tail=20']);await writeFile(`/tmp/${project}-startup.log`,logs.stdout+logs.stderr);}catch{/* Preserve the original failure. */}
  try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Search setup and cleanup failed');}throw error;
 }
}
export async function until(check:()=>Promise<boolean>|boolean,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Isolated search readiness/assertion deadline exceeded');}

// Real Elasticsearch HTTP forwarding with deterministic transient/lost-reply gates.
export async function elasticProxy(origin:string){
 let failure:number|undefined,paused=false,pausePath:string|undefined,resolveGate:(()=>void)|undefined;
 let captured:Promise<void>=Promise.resolve();const held:(()=>void)[]=[];
 const server=createServer(async(req,res)=>{
  if(failure){res.writeHead(failure,{'Content-Type':'application/json'});res.end('{"error":{"type":"test_transient"}}');return;}
  let body='';for await(const chunk of req)body+=chunk.toString();
  try{const upstream=await fetch(origin+req.url,{signal:AbortSignal.timeout(2000),method:req.method!,headers:{'Content-Type':'application/json'},...(body?{body}:{})});const text=await upstream.text();const send=()=>{if(!res.destroyed){res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(text);}};
   if(paused&&(!pausePath||req.url?.includes(pausePath))){held.push(send);resolveGate?.();}else send();
  }catch{if(!res.destroyed){res.writeHead(503);res.end();}}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,fail:(status?:number)=>{failure=status;},
 pause:(path?:string)=>{paused=true;pausePath=path;captured=new Promise(resolve=>{resolveGate=resolve;});},captured:()=>captured,
 release:()=>{paused=false;for(const send of held.splice(0))send();},
 close:()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})};
}
