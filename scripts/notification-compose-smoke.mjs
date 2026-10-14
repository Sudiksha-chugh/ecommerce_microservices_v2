// Run with: node --import tsx scripts/notification-compose-smoke.mjs
// Exercises the real notifications profile, merged with disposable resource overrides.
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {SignJWT,importPKCS8} from 'jose';
import amqp from 'amqplib';
import {Pool} from 'pg';
import {sagaEvent} from '../packages/messaging/src/saga-security.ts';
import {verifyInternalRequest} from '../packages/security/src/internal-service.ts';
const directory=await mkdtemp(join(tmpdir(),'commerce-v2-notification-smoke-'));
const project='commerce-v2-notification-smoke-'+randomBytes(5).toString('hex');
const env={},secret=()=>randomBytes(24).toString('hex'),source=await readFile('compose.yaml','utf8');
for(const match of source.matchAll(/\$\{([A-Z_]+)(?::([-?])([^}]*))?\}/g))env[match[1]]=match[2]==='-'?match[3]:secret();
Object.assign(env,{NOTIFICATIONS_DB_ADMIN_PASSWORD:secret(),NOTIFICATIONS_DATABASE_PASSWORD:secret(),MOCK_EMAIL_DATABASE_PASSWORD:secret(),RABBITMQ_ADMIN_USER:'smoke_admin',RABBITMQ_ADMIN_PASSWORD:secret(),RABBITMQ_VHOST:'smoke_notifications',NOTIFICATION_LOOKUP_KEY:secret(),SAGA_ORDERS_KEY:secret(),SAGA_PAYMENTS_KEY:secret(),JWT_ISSUER:'smoke-auth',JWT_AUDIENCE:'smoke-api',NOTIFICATION_WORKER_ENABLED:'false',NOTIFICATION_CONSUMER_ENABLED:'false',NOTIFICATION_RETRY_BASE_MS:'100',NOTIFICATION_SMOKE_PUBLIC_KEY:join(directory,'public.pem')});
env.NOTIFICATION_DOCKER_DATABASE_URL=`postgresql://notifications_user:${env.NOTIFICATIONS_DATABASE_PASSWORD}@notifications-db:5432/notifications_db`;
env.MOCK_EMAIL_DOCKER_DATABASE_URL=`postgresql://mock_email_user:${env.MOCK_EMAIL_DATABASE_PASSWORD}@notifications-db:5432/mock_email_provider_db`;
const brokerPassword=secret();env.NOTIFICATION_DOCKER_RABBITMQ_URL=`amqp://smoke_notifications:${brokerPassword}@rabbitmq:5672/smoke_notifications`;
const keyPair=generateKeyPairSync('rsa',{modulusLength:2048});await writeFile(env.NOTIFICATION_SMOKE_PUBLIC_KEY,keyPair.publicKey.export({type:'spki',format:'pem'}));
const key=await importPKCS8(keyPair.privateKey.export({type:'pkcs8',format:'pem'}),'RS256');
const userId=randomUUID(),orderId=randomUUID();
const contextServer=createServer((req,res)=>{
 if(!verifyInternalRequest(req.headers,req.method,req.url,env.NOTIFICATION_LOOKUP_KEY)){res.writeHead(401).end();return;}
 res.setHeader('content-type','application/json');
 if(req.url===`/internal/orders/${orderId}/notification-context`)res.end(JSON.stringify({orderId,userId,status:'CONFIRMED',amountPaise:'125',version:'1'}));
 else if(req.url===`/internal/users/${userId}/contact`)res.end(JSON.stringify({userId,email:'isolated-smoke@example.com'}));
 else res.writeHead(404).end();
});
await new Promise(r=>contextServer.listen(0,'0.0.0.0',r));
env.NOTIFICATION_DOCKER_AUTH_URL=env.NOTIFICATION_DOCKER_ORDERS_URL=`http://host.docker.internal:${contextServer.address().port}`;
const envFile=join(directory,'smoke.env'),base=['compose','-p',project,'--env-file',envFile,'-f','compose.yaml','-f','infrastructure/docker/compose.notifications-smoke.yaml','--profile','notifications'];
const save=()=>writeFile(envFile,Object.entries(env).map(([k,v])=>`${k}=${v}\n`).join(''),{mode:0o600});
async function docker(args){return new Promise((resolve,reject)=>{const child=spawn('docker',[...base,...args],{stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',d=>{output+=d;});child.stderr.on('data',d=>{error+=d;});child.once('error',reject);child.once('exit',code=>code===0?resolve(output.trim()):reject(new Error(`Compose ${args[0]} failed: ${error.slice(-3000)}`)));});}
async function port(service,target){const value=await docker(['port',service,String(target)]);return Number(value.split(':').at(-1));}
async function until(check,ms=30000){const started=Date.now();let failure;do{try{return await check();}catch(e){failure=e;await new Promise(r=>setTimeout(r,100));}}while(Date.now()-started<ms);throw failure;}
function assert(value,message){if(!value)throw new Error(message);}
let broker,pool,notificationPool;
const result={project,build:false,runtime:null,disabledDefaults:false,migrations:false,authorization:false,readiness:false,delivery:false,stableProviderOperation:false,shutdown:false,cleanup:false};
try{
 await save();console.log('Building Node 24 Notification image');await docker(['build','notification-service','notifications-db']);result.build=true;
 console.log('Starting disposable PostgreSQL and RabbitMQ');await docker(['up','-d','--wait','notifications-db','rabbitmq']);
 await docker(['run','--rm','--no-deps','notification-service','npm','run','migrate']);await docker(['run','--rm','--no-deps','notification-service','npm','run','mock:migrate']);result.migrations=true;
 await docker(['up','-d','--no-deps','notification-service']);
 const token=await new SignJWT({sub:randomUUID(),role:'admin'}).setProtectedHeader({alg:'RS256',typ:'JWT'}).setIssuer(env.JWT_ISSUER).setAudience(env.JWT_AUDIENCE).setIssuedAt().setExpirationTime('10m').sign(key);
 let origin=`http://127.0.0.1:${await port('notification-service',4007)}`;
 await until(async()=>{const r=await fetch(origin+'/health',{signal:AbortSignal.timeout(2000)});assert(r.status===200,'Liveness unavailable');});
 result.runtime=await docker(['exec','-T','notification-service','node','--version']);assert(result.runtime.startsWith('v24.'),'Image must use Node 24');
 let r=await fetch(origin+'/internal/notifications/readiness',{headers:{authorization:'Bearer '+token}});let body=await r.json();assert(r.status===200&&body.messaging==='disabled','Default consumer must be disabled');
 const flags=JSON.parse(await docker(['exec','-T','notification-service','node','-e',"console.log(JSON.stringify([process.env.NOTIFICATION_WORKER_ENABLED,process.env.NOTIFICATION_CONSUMER_ENABLED]))"]));assert(flags.every(v=>v==='false'),'Worker/consumer defaults must remain opt-in');result.disabledDefaults=true;
 r=await fetch(origin+'/internal/notifications');assert(r.status===401,'Unauthenticated management must be rejected');result.authorization=true;
 const managementOrigin=`http://127.0.0.1:${await port('rabbitmq',15672)}/api/`,authorization='Basic '+Buffer.from(`${env.RABBITMQ_ADMIN_USER}:${env.RABBITMQ_ADMIN_PASSWORD}`).toString('base64');
 async function put(path,body){await until(async()=>{const r=await fetch(managementOrigin+path,{method:'PUT',headers:{authorization,connection:'close','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2000)});assert(r.ok,'Isolated broker provisioning failed');await r.body?.cancel();});}
 await put('users/smoke_notifications',{password:brokerPassword,tags:''});const own='^(commerce\\.notifications\\.handoff|notifications\\..*)$';
 await put('permissions/smoke_notifications/smoke_notifications',{configure:own,write:own,read:'^(commerce\\.events|commerce\\.notifications\\.handoff|notifications\\..*)$'});
 await put('topic-permissions/smoke_notifications/smoke_notifications',{exchange:'commerce.events',write:'(?!)',read:'^(order\\.(confirmed|cancelled)|checkout\\.payment\\.(succeeded|failed)|payment\\.refund_(succeeded|failed|reconciliation_required))\\.v1$'});
 broker=await amqp.connect(`amqp://${env.RABBITMQ_ADMIN_USER}:${env.RABBITMQ_ADMIN_PASSWORD}@127.0.0.1:${await port('rabbitmq',5672)}/smoke_notifications`);const channel=await broker.createConfirmChannel();await channel.assertExchange('commerce.events','topic',{durable:true});
 env.NOTIFICATION_WORKER_ENABLED=env.NOTIFICATION_CONSUMER_ENABLED='true';await save();await docker(['up','-d','--no-deps','--force-recreate','notification-service']);origin=`http://127.0.0.1:${await port('notification-service',4007)}`;
 await until(async()=>{const r=await fetch(origin+'/internal/notifications/readiness',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(2000)});const b=await r.json();assert(r.status===200&&b.messaging==='ready','Consumer not ready');});result.readiness=true;
 const event=sagaEvent('order.confirmed',{orderId,userId,totalAmountPaise:125,currency:'INR',confirmedAt:new Date().toISOString(),orderVersion:'1'},{'orders-service':env.SAGA_ORDERS_KEY,'payments-service':env.SAGA_PAYMENTS_KEY,'inventory-service':secret()},randomUUID());
 const publish=async()=>{channel.publish('commerce.events','order.confirmed.v1',Buffer.from(JSON.stringify(event)),{persistent:true,contentType:'application/json'});await channel.waitForConfirms();};await publish();
 let notification;await until(async()=>{const r=await fetch(origin+'/internal/notifications',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(2000)});const b=await r.json();assert(b.notifications?.length===1&&b.notifications[0].status==='SENT','Delivery not settled');notification=b.notifications[0];});result.delivery=true;
 await publish();await docker(['restart','notification-service']);origin=`http://127.0.0.1:${await port('notification-service',4007)}`;await until(async()=>{const r=await fetch(origin+'/internal/notifications',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(2000)});const b=await r.json();assert(b.notifications?.length===1&&b.notifications[0].status==='SENT','Restart lost delivery');});
 pool=new Pool({host:'127.0.0.1',port:await port('notifications-db',5432),database:'mock_email_provider_db',user:'mock_email_user',password:env.MOCK_EMAIL_DATABASE_PASSWORD,max:1});const rows=(await pool.query('SELECT operation_id,status,send_calls FROM mock_email_deliveries')).rows;assert(rows.length===1&&rows[0].status==='ACCEPTED'&&rows[0].send_calls===1,'Provider acceptance must remain singular');notificationPool=new Pool({host:'127.0.0.1',port:await port('notifications-db',5432),database:'notifications_db',user:'notifications_user',password:env.NOTIFICATIONS_DATABASE_PASSWORD,max:1});const intent=(await notificationPool.query('SELECT provider_operation_id FROM notifications WHERE id=$1',[notification.notificationId])).rows[0];assert(rows[0].operation_id===intent.provider_operation_id,'Provider operation must remain stable');result.stableProviderOperation=true;
 await docker(['stop','notification-service']);const id=await docker(['ps','--all','--quiet','notification-service']);const exit=await new Promise((resolve,reject)=>{const p=spawn('docker',['inspect','--format','{{.State.ExitCode}}',id]);let out='';p.stdout.on('data',d=>out+=d);p.once('error',reject);p.once('exit',code=>code===0?resolve(out.trim()):reject(new Error('Exit inspection failed')));});assert(exit==='0','Notification shutdown must exit cleanly');result.shutdown=true;
}catch(error){try{console.error(await docker(['logs','--tail','40','notifications-db','rabbitmq','notification-service']));}catch{}throw error;}finally{
 await Promise.all([pool?.end(),notificationPool?.end()]);await broker?.close();await new Promise(r=>{contextServer.close(()=>r());contextServer.closeAllConnections();});
 try{await docker(['down','--volumes','--remove-orphans']);result.cleanup=true;}finally{await rm(directory,{recursive:true,force:true});console.log(JSON.stringify(result));}
}
