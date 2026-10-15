import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import amqp from 'amqplib';
import { createJwtFixture } from '../test/jwt-fixture.ts';
import { migrate as catalogMigrate } from '../apps/catalog-service/src/db/migrate.ts';
import { ProductRepository } from '../apps/catalog-service/src/product-repository.ts';
import { CatalogSearchSource } from '../apps/catalog-service/src/search-source.ts';
import { createApp as catalogApp } from '../apps/catalog-service/src/app.ts';
import { signProducerEvent,validateEvent } from '../packages/messaging/src/index.ts';
import { Elasticsearch } from '../apps/search-service/src/elasticsearch.ts';
const project=`commerce-v2-search-smoke-${randomUUID().slice(0,10)}`;
const directory=await mkdtemp(join(tmpdir(),'commerce-v2-search-smoke-'));
const envFile=join(directory,'smoke.env'),publicKey=join(directory,'public.pem');const jwt=await createJwtFixture();await writeFile(publicKey,jwt.publicPem);
const lookupKey='isolated-profile-search-lookup-xxxxxxxxxx',eventKey='isolated-profile-catalog-event-xxxxxxxxxx',cursorKey='isolated-profile-search-cursor-xxxxxxxxxx';
const defaults={PGUSER:'unused_smoke_only',PGPASSWORD:'unused_smoke_only',CATALOG_TEST_PASSWORD:'unused_smoke_only',RABBITMQ_ADMIN_USER:'search_smoke_admin',RABBITMQ_ADMIN_PASSWORD:'isolated_smoke_broker_only',RABBITMQ_VHOST:'search_smoke',
 SEARCH_DB_ADMIN_PASSWORD:'isolated_smoke_pg_admin_only',SEARCH_DATABASE_PASSWORD:'isolated_smoke_search_only',SEARCH_DOCKER_DATABASE_URL:'postgresql://search_user:isolated_smoke_search_only@search-db:5432/search_db',SEARCH_SMOKE_PUBLIC_KEY:publicKey,
 SEARCH_INDEX_ALIAS:`commerce_v2_products_smoke_${randomUUID().replaceAll('-','').slice(0,12)}`,SEARCH_LOOKUP_KEY:lookupKey,CATALOG_EVENT_KEY:eventKey,SEARCH_CURSOR_KEY:cursorKey,JWT_ISSUER:jwt.settings.issuer,JWT_AUDIENCE:jwt.settings.audience};
for(const prefix of ['AUTH','ORDERS','INVENTORY','PAYMENTS','MOCK']){defaults[`${prefix}_PGPASSWORD`]='unused_smoke_only';defaults[`${prefix}_TEST_PASSWORD`]='unused_smoke_only';}
let enabled=false;const writeEnv=async(extra={})=>writeFile(envFile,Object.entries({...defaults,SEARCH_ENABLED:String(enabled),SEARCH_INDEXING_ENABLED:String(enabled),SEARCH_REBUILD_ENABLED:String(enabled),...extra}).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
await writeEnv();const base=['compose','-p',project,'--env-file',envFile,'-f','compose.yaml','-f','infrastructure/docker/compose.search-smoke.yaml','--profile','search'];
const docker=args=>new Promise((resolve,reject)=>{const child=spawn('docker',[...base,...args],{env:{...process.env,SEARCH_SMOKE_PUBLIC_KEY:publicKey}});let output='',error='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);child.once('error',reject);child.once('exit',code=>code===0?resolve(output.trim()):reject(new Error(`Search smoke Compose ${args[0]} failed: ${error.slice(-5000)}`)));});
const hostPort=async(service,port)=>Number((await docker(['port',service,String(port)])).split(':').at(-1));
async function until(check,budget=60000){const deadline=Date.now()+budget;while(Date.now()<deadline){try{if(await check())return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Isolated Search smoke deadline exceeded');}
let admin,sourcePool,server,connection;
const result={project,build:false,disabledDefaults:false,migrations:false,authorization:false,brokerPermissions:false,rebuild:false,delivery:false,aliasReplacement:false,shutdown:false,cleanup:false};
try{
 console.info(JSON.stringify({component:'search-smoke',project,stage:'building_real_profile'}));await docker(['config','--quiet']);await docker(['build','search-db','search-service']);result.build=true;
 await docker(['up','-d','--no-deps','search-db','search-elasticsearch','rabbitmq']);
 // Cold JVM startup is a separate observed infrastructure preflight, not a longer request/assertion timeout.
 console.info(JSON.stringify({component:'search-smoke',project,stage:'waiting_for_disposable_stores'}));
 const pgPort=await hostPort('search-db',5432),esPort=await hostPort('search-elasticsearch',9200),mqPort=await hostPort('rabbitmq',5672),managementPort=await hostPort('rabbitmq',15672);
 admin=new Pool({host:'127.0.0.1',port:pgPort,database:'postgres',user:'search_admin',password:defaults.SEARCH_DB_ADMIN_PASSWORD,connectionTimeoutMillis:2000});admin.on('error',()=>{});
 await until(async()=>{await admin.query('SELECT 1');return true;});
 await until(async()=>{const response=await fetch(`http://127.0.0.1:${esPort}/_cluster/health?wait_for_status=yellow`,{signal:AbortSignal.timeout(2000)});return response.ok;},900000);
 const elastic=new Elasticsearch(`http://127.0.0.1:${esPort}`,defaults.SEARCH_INDEX_ALIAS,2000);
 const warm=defaults.SEARCH_INDEX_ALIAS+'_smoke_probe';
 await until(async()=>{await elastic.create(warm);await elastic.refresh(warm);return true;});
 await elastic.request('DELETE',`/${warm}`);
 const management=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${managementPort}/api/${path}`,{method:body?'PUT':'GET',headers:{Authorization:'Basic '+Buffer.from(defaults.RABBITMQ_ADMIN_USER+':'+defaults.RABBITMQ_ADMIN_PASSWORD).toString('base64'),'Content-Type':'application/json'},signal:AbortSignal.timeout(2000),...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error('Smoke broker provisioning failed');};
 await until(async()=>{await management('overview');return true;});
 connection=await amqp.connect(`amqp://${defaults.RABBITMQ_ADMIN_USER}:${defaults.RABBITMQ_ADMIN_PASSWORD}@127.0.0.1:${mqPort}/search_smoke`);connection.on('error',()=>{});const channel=await connection.createChannel();await channel.assertExchange('commerce.events','topic',{durable:true});
 await management('users/search_smoke_consumer',{password:'isolated_search_consumer_only',tags:''});
 const owned='^(commerce\\.search\\.handoff|search\\..*)$';await management('permissions/search_smoke/search_smoke_consumer',{configure:owned,write:owned,read:'^(commerce\\.events|commerce\\.search\\.handoff|search\\..*)$'});
 await management('topic-permissions/search_smoke/search_smoke_consumer',{exchange:'commerce.events',write:'(?!)',read:'^catalog\\.product\\.(created|updated|deleted)\\.v1$'});
 await admin.query("CREATE ROLE catalog_smoke LOGIN PASSWORD 'isolated_catalog_smoke_only'");await admin.query('CREATE DATABASE catalog_test_db OWNER catalog_smoke');await admin.query('REVOKE CONNECT ON DATABASE catalog_test_db FROM PUBLIC');
 sourcePool=new Pool({host:'127.0.0.1',port:pgPort,database:'catalog_test_db',user:'catalog_smoke',password:'isolated_catalog_smoke_only'});sourcePool.on('error',()=>{});await catalogMigrate(sourcePool);
 const products=new ProductRepository(sourcePool);server=createServer(catalogApp(products,jwt.verify,new CatalogSearchSource(sourcePool),lookupKey));await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
 const sourcePort=server.address().port;const extra={SEARCH_DOCKER_CATALOG_URL:`http://host.docker.internal:${sourcePort}`,SEARCH_DOCKER_RABBITMQ_URL:'amqp://search_smoke_consumer:isolated_search_consumer_only@rabbitmq:5672/search_smoke'};await writeEnv(extra);
 await docker(['run','--rm','--no-deps','search-service','node','--import','tsx','src/migrate-cli.ts']);result.migrations=true;
 await docker(['up','-d','--no-deps','search-service']);const port=await hostPort('search-service',4008);let origin=`http://127.0.0.1:${port}`;
 await until(async()=>{const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)});return response.ok;});
 if((await fetch(origin+'/search/products')).status!==404)throw new Error('Search was enabled by default');if((await fetch(origin+'/ready')).status!==200)throw new Error('Disabled profile not ready');result.disabledDefaults=true;
 enabled=true;await writeEnv(extra);await docker(['up','-d','--no-deps','--force-recreate','search-service']);origin=`http://127.0.0.1:${await hostPort('search-service',4008)}`;
 await until(async()=>{const response=await fetch(origin+'/admin/search/index-status',{headers:{Authorization:`Bearer ${await jwt.sign()}`},signal:AbortSignal.timeout(1000)});return response.ok;});
 await channel.assertQueue('orders.smoke-private.v1',{durable:false});
 const restricted=await amqp.connect(`amqp://search_smoke_consumer:isolated_search_consumer_only@127.0.0.1:${mqPort}/search_smoke`);restricted.on('error',()=>{});
 try{for(const operation of ['configure','read']){const c=await restricted.createChannel();c.on('error',()=>{});let denied=false;try{if(operation==='configure')await c.assertQueue('orders.smoke-forbidden.v1');else await c.get('orders.smoke-private.v1',{noAck:false});}catch(error){denied=(error.code??error.fields?.replyCode)===403;}if(!denied)throw new Error('Search broker least privilege failed');}}finally{await restricted.close();}
 result.brokerPermissions=true;
 if((await fetch(origin+'/admin/search/rebuild',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status!==401)throw new Error('Missing admin token accepted');
 if((await fetch(origin+'/admin/search/rebuild',{method:'POST',headers:{Authorization:`Bearer ${await jwt.sign('customer')}`,'Content-Type':'application/json'},body:'{}'})).status!==403)throw new Error('Customer rebuild accepted');result.authorization=true;
 const rebuild=async()=>{const response=await fetch(origin+'/admin/search/rebuild',{method:'POST',headers:{Authorization:`Bearer ${await jwt.sign()}`,'Content-Type':'application/json'},body:'{}'});if(response.status!==202)throw new Error('Rebuild not admitted');const job=await response.json();await until(async()=>{const current=await fetch(origin+'/admin/search/rebuild/'+job.id,{headers:{Authorization:`Bearer ${await jwt.sign()}`},signal:AbortSignal.timeout(2000)});return (await current.json()).status==='COMPLETE';},60000);return job.id;};
 const p=await products.create({name:'Wireless Headphones',description:'Bluetooth music',priceInPaise:249900});await rebuild();result.rebuild=true;
 await products.update(p.id,{name:'Durable Search Headphones'});const event=signProducerEvent(validateEvent((await sourcePool.query('SELECT envelope FROM outbox_events WHERE aggregate_id=$1 ORDER BY (payload->>\'productVersion\')::bigint DESC LIMIT 1',[p.id])).rows[0].envelope),eventKey);
 channel.publish('commerce.events','catalog.product.updated.v1',Buffer.from(JSON.stringify(event)),{persistent:true,contentType:'application/json'});
 await until(async()=>{const response=await fetch(origin+'/search/products?q=Durable',{signal:AbortSignal.timeout(2000)});if(!response.ok)return false;return (await response.json()).data.some(row=>row.id===p.id&&row.name==='Durable Search Headphones');},30000);result.delivery=true;
 await rebuild();result.aliasReplacement=true;
 await docker(['stop','-t','10','search-service']);const container=await docker(['ps','-a','-q','search-service']);const exit=await new Promise((resolve,reject)=>{const child=spawn('docker',['inspect','--format','{{.State.ExitCode}}',container]);let text='';child.stdout.on('data',d=>text+=d);child.once('exit',code=>code?reject(new Error('Inspect failed')):resolve(text.trim()));});if(exit!=='0')throw new Error('Search did not shut down cleanly');result.shutdown=true;
 console.info(JSON.stringify({component:'search-smoke',stage:'passed',runtime:await docker(['run','--rm','--no-deps','search-service','node','--version'])}));
}finally{
 if(connection)await connection.close().catch(()=>{});if(server)await new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections();});if(sourcePool)await sourcePool.end();if(admin)await admin.end();
 await docker(['down','--remove-orphans']);result.cleanup=true;await rm(directory,{recursive:true,force:true});console.info(JSON.stringify(result));
}
