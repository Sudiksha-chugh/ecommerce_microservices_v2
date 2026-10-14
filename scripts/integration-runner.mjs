// Starts fresh disposable stores, runs every requested Vitest test, cleans only its own project.
import {mkdtemp,writeFile,rm,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {performance} from 'node:perf_hooks';
import amqp from 'amqplib';
import {observe} from './integration-observer.mjs';
import {observeStartup} from './integration-startup-observer.mjs';
import {brokerFunctionalReady,rewriteEndpoints,stabilityPlan,reportLocation,gatedStages,startupGuard,withExecutionMode,validateGateReport,retainReport,cleanupOwned} from './verification-harness.mjs';
const host=process.env.INTEGRATION_EXECUTION==='host';
const messagingOnly=process.env.INTEGRATION_MESSAGING_ONLY==='true';
if(messagingOnly&&((process.argv[2]!=='packages/messaging/test'||process.argv.slice(3).some(arg=>!/^--(?:reporter|outputFile(?:\.[a-z]+)?)=/.test(arg)))||process.env.INTEGRATION_RECOVERY_STAGES==='true'||process.env.INTEGRATION_PROBE))throw new Error('Messaging-only comparison requires the complete Messaging suite');
const setupProbe=process.env.INTEGRATION_PROBE==='search-setup';
const latencyStages=process.env.INTEGRATION_LATENCY_STAGES==='true';
const stabilityStages=process.env.INTEGRATION_STABILITY_STAGES==='true';
const recoveryStages=process.env.INTEGRATION_RECOVERY_STAGES==='true';
if(stabilityStages&&(!recoveryStages||!latencyStages))throw new Error('Stability stages require gated latency verification');
if(latencyStages&&!recoveryStages)throw new Error('Latency stages require gated recovery execution');
if(recoveryStages&&(setupProbe||!process.env.INTEGRATION_REPORT_DIR||process.argv.length>2))throw new Error('Recovery stages require a report directory and no test/probe override');
if(process.env.INTEGRATION_PROBE&&!setupProbe)throw new Error('Unknown integration probe');
if(setupProbe&&!host)throw new Error('Setup-only diagnostic probe requires explicit host execution');
if(process.versions.node.split('.')[0]!=='24')throw new Error('Isolated verification requires Node.js 24');
const observer=observe(process.env.INTEGRATION_DIAGNOSTICS_FILE);
let interrupted=false,activeTest,activeDocker;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted=true;activeTest?.kill('SIGTERM');activeDocker?.kill('SIGTERM');});
const project='commerce-v2-stabilization-'+randomBytes(6).toString('hex'),directory=await mkdtemp(join(tmpdir(),project+'-'));
const outputDirectory=join(directory,'output');await mkdir(outputDirectory);
const ownedRunContainers=new Set();
let setExecutionPorts;
const dockerEnvironment={...process.env,INTEGRATION_ENV_DIRECTORY:directory,INTEGRATION_OUTPUT_DIR:outputDirectory};
const base=['compose','-p',project,'-f','infrastructure/docker/compose.integration-test.yaml'];
async function docker(args){if(args[0]==='run'){const name=project+'-runner-'+randomBytes(4).toString('hex');ownedRunContainers.add(name);args=['run','--name',name,...args.slice(1)];}return observer.measure('docker_'+args[0],()=>new Promise((resolve,reject)=>{
 if(interrupted&&!['down','logs','ps'].includes(args[0])){reject(new Error('Verification interrupted'));return;}
 const child=spawn('docker',[...base,...args],{env:dockerEnvironment});activeDocker=child;let output='',error='',expired=false;
 const timer=setTimeout(()=>{expired=true;child.kill('SIGTERM');},args[0]==='build'?300000:120000);
 const kill=setTimeout(()=>{if(expired)child.kill('SIGKILL');},args[0]==='build'?310000:130000);
 child.stdout.on('data',d=>output=(output+d).slice(-100000));child.stderr.on('data',d=>error=(error+d).slice(-100000));
 child.once('error',err=>{clearTimeout(timer);clearTimeout(kill);reject(err);});child.once('exit',code=>{activeDocker=undefined;clearTimeout(timer);clearTimeout(kill);code===0&&!expired?resolve(output.trim()):reject(new Error(`Isolated Compose ${args[0]} ${expired?'deadline exceeded':'failed'}: ${error}`));});
}));}
async function port(service,target){return Number((await docker(['port',service,String(target)])).split(':').at(-1));}
async function ready(check,operation='broker_management'){return observer.measure(operation,async()=>{const started=performance.now();let failure;do{if(interrupted)throw new Error('Verification interrupted');try{return await check();}catch(error){failure=error;await new Promise(r=>setTimeout(r,100));}}while(performance.now()-started<30000);throw failure;});}
const repeat=Number(process.env.INTEGRATION_REPEAT??1);
if(!Number.isInteger(repeat)||repeat<1||repeat>3)throw new Error('Integration repeat must be between one and three');
let admin,code=1,probeTimer,probeActive,builtImage;
const probe={queries:0,failures:0,maxQueryMs:0,maxTimerGapMs:0};
try{
 console.log(JSON.stringify({component:'integration-runner',project,runtime:process.version,outcome:'starting_isolated_stores'}));console.log(host?'Using host Node 24 with generated isolated endpoints':'Building the Node 24 integration image');if(!host){builtImage=(await docker(['--profile','runner','config','--images'])).split('\n').find(value=>value===project+'-test-runner');if(!builtImage)throw new Error('Cannot identify owned integration image');await docker(['build','test-runner']);}
 console.log(JSON.stringify({component:'integration-runner',project,outcome:'image_built_starting_stores'}));
 const closeStartup=process.env.INTEGRATION_STARTUP_AUDIT==='true'?observeStartup(project,observer.emit):undefined;
 try{await docker(['up','-d','--wait',...(messagingOnly?['postgres','rabbitmq']:['postgres','rabbitmq','redis','search-postgres'])]);}finally{await closeStartup?.();}
 if(!messagingOnly)await docker(['up','-d','search-elasticsearch']);
 console.log(JSON.stringify({component:'integration-runner',project,outcome:'stores_started_provisioning'}));
 const pgPort=await port('postgres',5432),amqpPort=await port('postgres',5672),managementPort=await port('postgres',15672),redisPort=await port('postgres',6379),password=randomBytes(24).toString('hex');
 const adminUrl=`postgresql://notification_test_admin:isolated_regression_admin_only@127.0.0.1:${pgPort}/postgres`;admin=new Pool({connectionString:adminUrl,max:1,connectionTimeoutMillis:5000,statement_timeout:2000});
 const client=await observer.measure('postgres_connect',()=>admin.connect());let identity;try{identity=(await observer.measure('postgres_query',()=>client.query('SELECT current_user,current_database()'))).rows[0];}finally{client.release();}if(identity.current_user!=='notification_test_admin'||identity.current_database!=='postgres')throw new Error('Refusing unexpected integration administrator');
 for(const service of ['catalog','auth','orders','inventory','payments','mock_provider']){
  const role=`${service}_test_user`,database=`${service}_test_db`;
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`);await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
  // Empty non-test databases allow existing connection-denial assertions to remain exact.
  await admin.query(`CREATE DATABASE "${service}_db"`);await admin.query(`REVOKE CONNECT ON DATABASE "${service}_db" FROM PUBLIC`);
 }
 const write=async(name,values)=>writeFile(join(directory,name),Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(''),{mode:0o600});
 await write('.env',{PGHOST:'127.0.0.1',PGPORT:host?pgPort:5432,CATALOG_TEST_PASSWORD:password});
 for(const service of ['auth','orders','inventory','payments','mock']){const prefix=service.toUpperCase();await write(service==='mock'?'.env.mock-provider':`.env.${service}`,{[prefix+'_PGHOST']:'127.0.0.1',[prefix+'_PGPORT']:host?pgPort:5432,[prefix+'_TEST_PASSWORD']:password});}
 await write('.env.cart',{CART_TEST_REDIS_URL:`redis://127.0.0.1:${host?redisPort:6379}/15`});
 await write('.env.messaging',{RABBITMQ_ADMIN_USER:'stabilization_admin',RABBITMQ_ADMIN_PASSWORD:'isolated_regression_broker_only',RABBITMQ_TEST_PASSWORD:password,RABBITMQ_AMQP_PORT:host?amqpPort:5672,RABBITMQ_MANAGEMENT_PORT:host?managementPort:15672});
 const origin=`http://127.0.0.1:${managementPort}/api/`,authorization='Basic '+Buffer.from('stabilization_admin:isolated_regression_broker_only').toString('base64');
 await ready(async()=>{const r=await fetch(origin+'overview',{headers:{authorization,connection:'close'},signal:AbortSignal.timeout(2000)});if(!r.ok){await r.body?.cancel();throw new Error('Broker management is not ready');}await r.json();});
 const preflight=await observer.measure('amqp_connect',()=>ready(()=>amqp.connect(`amqp://stabilization_admin:isolated_regression_broker_only@127.0.0.1:${amqpPort}/commerce_test`,{timeout:2000})));preflight.on('error',()=>{});
 await observer.measure('amqp_functional_ready',()=>brokerFunctionalReady(preflight,project));
 for(const [path,body] of [['users/commerce_test',{password,tags:''}],['permissions/commerce_test/commerce_test',{configure:'^test_[a-z0-9_]+\\..*$',write:'^test_[a-z0-9_]+\\..*$',read:'^test_[a-z0-9_]+\\..*$'}]])await ready(async()=>{const r=await fetch(origin+path,{method:'PUT',headers:{authorization,connection:'close','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2000)});if(!r.ok)throw new Error('Isolated broker provisioning failed');await r.body?.cancel();});
 // Search uses a separate vhost and PostgreSQL cluster. No Docker socket is
 // exposed to the test process, and its fixture cannot control other projects.
 for(const [path,body] of [['vhosts/search_test',{}],['users/search_test_broker',{password:'isolated_search_broker_only',tags:'administrator'}],['permissions/search_test/search_test_broker',{configure:'.*',write:'.*',read:'.*'}]])await ready(async()=>{const r=await fetch(origin+path,{method:'PUT',headers:{authorization,connection:'close','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2000)});if(!r.ok)throw new Error('Isolated Search broker provisioning failed');await r.body?.cancel();});
 if(!messagingOnly){
 // Observed cold JVM initialization is infrastructure preflight, independent
 // of unchanged application RPC and suite hook deadlines.
 const esPort=await port('postgres',9200);
 const searchHostPort=host||stabilityStages?await port('postgres',5441):undefined;
 if(stabilityStages)setExecutionPorts=executionHost=>rewriteEndpoints(directory,executionHost,{postgres:pgPort,searchPostgres:searchHostPort,amqp:amqpPort,management:managementPort,redis:redisPort,elastic:esPort});
 await write('.env.search-test',{PGPORT:host?searchHostPort:5441,AMQP_PORT:host?amqpPort:5672,MANAGEMENT_PORT:host?managementPort:15672,ELASTIC_PORT:host?esPort:9200});
 const coldDeadline=performance.now()+900000;
 console.log(JSON.stringify({component:'integration-runner',project,outcome:'waiting_for_cold_elasticsearch'}));
 const elasticStarted=performance.now();let elasticReady=false;
 while(performance.now()<coldDeadline){if(interrupted)throw new Error('Verification interrupted');try{const r=await fetch(`http://127.0.0.1:${esPort}/_cluster/health?wait_for_status=yellow`,{signal:AbortSignal.timeout(2000)});elasticReady=r.ok;await r.body?.cancel();if(elasticReady)break;}catch{}await new Promise(r=>setTimeout(r,1000));}
 observer.emit('elasticsearch_readiness',{durationMs:performance.now()-elasticStarted,ready:elasticReady});
 if(!elasticReady)throw new Error('Isolated Elasticsearch cold startup failed');
 // Cluster health does not initialize the real mapping/write/refresh/alias/search paths.
 // Complete that preflight BEFORE test hooks, using the remainder of the same 15m cold budget.
 await observer.measure('elasticsearch_functional_preflight',()=>new Promise((resolve,reject)=>{
  const remaining=Math.max(0,coldDeadline-performance.now());
  const child=spawn(process.execPath,['--import','tsx','scripts/search-functional-preflight.mjs'],{stdio:'inherit',env:{...process.env,INTEGRATION_ENV_DIR:directory,INTEGRATION_OWNED_PROJECT:project,INTEGRATION_COLD_BUDGET_MS:String(remaining),INTEGRATION_OWNED_ELASTIC_PORT:String(esPort)}});activeTest=child;
  let expired=false;const timer=setTimeout(()=>{expired=true;child.kill('SIGTERM');},remaining+2000);
  const kill=setTimeout(()=>{if(expired)child.kill('SIGKILL');},remaining+4000);
  child.once('error',error=>{clearTimeout(timer);clearTimeout(kill);activeTest=undefined;reject(error);});
  child.once('exit',exit=>{clearTimeout(timer);clearTimeout(kill);activeTest=undefined;exit===0&&!expired?resolve():reject(new Error('Isolated Elasticsearch functional preflight failed'));});
 }));
 }
 let previousTick=performance.now();probeTimer=setInterval(()=>{const now=performance.now();probe.maxTimerGapMs=Math.max(probe.maxTimerGapMs,now-previousTick);previousTick=now;if(probeActive)return;probeActive=(async()=>{const started=performance.now();try{await admin.query('SELECT 1');probe.queries++;}catch{probe.failures++;}finally{probe.maxQueryMs=Math.max(probe.maxQueryMs,performance.now()-started);}})().finally(()=>{probeActive=undefined;});},1000);probeTimer.unref();
 console.log(JSON.stringify({component:'integration-runner',project,outcome:'ready',postgresPort:pgPort,amqpPort,redisPort}));
 const outputFiles=[],args=process.argv.slice(2).map(arg=>{const match=arg.match(/^(--outputFile(?:\.[a-z]+)?)=(.+)$/);if(!match)return arg;const local=`report-${outputFiles.length}.json`;outputFiles.push({local,host:resolve(match[2])});return `${match[1]}=${host?join(outputDirectory,local):'/integration-output/'+local}`;});
 console.log(JSON.stringify({component:'integration-runner',outcome:host?'running_on_host_with_isolated_stores':'running_inside_store_namespace',runtime:host?process.version:'Node 24 image; isolated worker runtime check enabled'}));
 const run=(runArgs,probeMode=setupProbe?'setup':undefined,probeReport=process.env.INTEGRATION_PROBE_REPORT,executionHost=host)=>observer.measure(probeMode?'search_setup_probe':'vitest',()=>new Promise((resolve,reject)=>{
 if(interrupted){resolve(130);return;}
 const testArguments=probeMode?['--import','tsx','scripts/search-setup-probe.mjs']:['node_modules/vitest/vitest.mjs','run',...runArgs];
 const containerName=project+'-runner-'+randomBytes(4).toString('hex');if(!executionHost)ownedRunContainers.add(containerName);
 const containerEnvironment=['-e','INTEGRATION_DIAGNOSTICS_FILE=/integration-output/worker-diagnostics.jsonl','-e','INTEGRATION_DIAGNOSTICS_MODE='+ (process.env.INTEGRATION_DIAGNOSTICS_MODE??'existing')];
 if(probeMode)containerEnvironment.push('-e','INTEGRATION_PROBE_MODE='+probeMode,'-e','INTEGRATION_PROBE_REPORT='+probeReport);
 const child=executionHost?spawn(process.execPath,testArguments,{stdio:'inherit',env:{...process.env,INTEGRATION_ENV_DIR:directory,INTEGRATION_SEARCH_STORES:'true',NOTIFICATION_TEST_ADMIN_URL:adminUrl,INTEGRATION_PROBE_MODE:probeMode,INTEGRATION_PROBE_REPORT:probeReport}}):spawn('docker',[...base,'run','--name',containerName,'--rm','--no-deps',...containerEnvironment,'test-runner',...testArguments],{stdio:'inherit',env:dockerEnvironment});
 let startupPoll,startupProbe,lastProbeCode;
 const guard=startupGuard(executionHost,()=>{observer.emit('runner_container_start_deadline',{name:containerName,code:lastProbeCode??'NOT_STARTED'});child.kill('SIGTERM');});
 const clearStartup=()=>{guard.close();clearInterval(startupPoll);};
 if(!executionHost){
  startupPoll=setInterval(()=>{if(startupProbe)return;startupProbe=(async()=>{try{
   const state=JSON.parse((await execute('docker',['inspect','--format','{{json .State}}',containerName],{timeout:2000,maxBuffer:10000})).stdout);
   guard.observe(state);if(state.StartedAt&&!state.StartedAt.startsWith('0001-')){clearStartup();observer.emit('runner_container_started',{name:containerName,startedAt:state.StartedAt,status:state.Status});}
  }catch(error){lastProbeCode=error.code??error.name;}finally{startupProbe=undefined;}})();},1000);
 }
 activeTest=child;child.once('error',error=>{clearStartup();reject(error);});child.once('exit',async exit=>{clearStartup();await startupProbe;activeTest=undefined;observer.emit('vitest_exit',{exitCode:exit??1,startupDeadlineExceeded:guard.expired});resolve(guard.expired?1:exit??1);});
}));
 code=0;
 if(process.env.INTEGRATION_NOTIFICATION_REPORT){
  console.log(JSON.stringify({component:'integration-runner',outcome:'notification_independent'}));
  const result=await run(['apps/notification-service/test','--reporter=json',`--outputFile=${host?join(outputDirectory,'notifications.json'):'/integration-output/notifications.json'}`]);
  if(result!==0)code=result;await copyFile(join(outputDirectory,'notifications.json'),resolve(process.env.INTEGRATION_NOTIFICATION_REPORT));
 }
 if(recoveryStages){
  const reportDirectory=resolve(process.env.INTEGRATION_REPORT_DIR);await mkdir(reportDirectory,{recursive:true});
  let stages=[
   {name:'B-messaging',files:['packages/messaging/test']},
   {name:'C-search-setup',probe:latencyStages?'latency':'setup'},
   {name:'D-search-single',probe:'single'},
   ...(latencyStages?[{name:'T-search-targeted',files:['apps/search-service/test/integration.test.ts','--testNamePattern=fixture cleanup regression|Search cannot connect to the private Catalog database|concurrent consumers cannot roll back a newer version|replaying an old event after loss of a physical index|inbox commit failure after Elasticsearch success']}]:[]),
   {name:'E-search-run1',files:['apps/search-service/test']},
   {name:'F-search-run2',files:['apps/search-service/test']},
   {name:'G-regression-run1',files:[]},
   {name:'H-regression-run2',files:[]},
  ];
  if(stabilityStages)stages=stabilityPlan();
  code=await gatedStages(stages,async stage=>{
   console.log(JSON.stringify({component:'integration-runner',outcome:'recovery_stage_begin',stage:stage.name}));
   const stageHost=stage.host??host;
   const {target,local,output}=reportLocation(stage,reportDirectory,outputDirectory,stageHost);
   if(!stageHost&&!builtImage){builtImage=(await docker(['--profile','runner','config','--images'])).split('\n').find(value=>value===project+'-test-runner');if(!builtImage)throw new Error('Cannot identify owned integration image');await docker(['build','test-runner']);}
   const result=await withExecutionMode(host,stageHost,setExecutionPorts,()=>stage.probe?run([],stage.probe,stageHost?target:output,stageHost):run([...stage.files,'--reporter=default','--reporter=json',`--outputFile=${output}`],undefined,undefined,stageHost));
   const report=await retainReport(stage.probe&&stageHost?target:local,target);
   if(result===0)validateGateReport(stage,report);
   observer.emit('recovery_stage_end',{stage:stage.name,exitCode:result});
   return result;
  },{interrupted:()=>interrupted});
 }else for(let iteration=1;iteration<=repeat&&!interrupted;iteration++){
  console.log(JSON.stringify({component:'integration-runner',outcome:'regression_iteration',iteration}));
  const result=await run(args);if(result!==0)code=result;
  for(const file of outputFiles){const target=iteration===1?file.host:file.host.replace(/(\.[^/.]+)?$/,`-repeat${iteration}$1`);await copyFile(join(outputDirectory,file.local),target);}
 }
}catch(error){observer.emit('runner_failure',{code:error?.cause?.code??error?.code??error?.name??'ERROR'});try{console.error(await docker(['logs','--tail','30']));}catch{}throw error;}finally{
 clearInterval(probeTimer);await probeActive;observer.emit('probe_summary',probe);
 try{observer.emit('postgres_activity',{rows:(await admin?.query("SELECT state,wait_event_type,count(*)::int AS connections FROM pg_stat_activity WHERE backend_type='client backend' GROUP BY state,wait_event_type"))?.rows});}catch{}
 try{const ids=(await execute('docker',[...base,'ps','-q'],{timeout:5000})).stdout.trim().split('\n').filter(Boolean);for(const id of ids){const result=await execute('docker',['inspect','--format','{{json .State}}',id],{timeout:5000,maxBuffer:20000});const {Running,Paused,Restarting,OOMKilled,ExitCode}=JSON.parse(result.stdout);observer.emit('container_state',{Running,Paused,Restarting,OOMKilled,ExitCode});}if(ids.length)observer.emit('container_resources',{sample:(await execute('docker',['stats','--no-stream','--format','{{.Name}} {{.CPUPerc}} {{.MemUsage}}',...ids],{timeout:5000,maxBuffer:20000})).stdout});}catch{observer.emit('container_diagnostics',{outcome:'deadline_or_unavailable'});} 
 if((!host||ownedRunContainers.size)&&process.env.INTEGRATION_DIAGNOSTICS_FILE)try{await copyFile(join(outputDirectory,'worker-diagnostics.jsonl'),resolve(process.env.INTEGRATION_DIAGNOSTICS_FILE.replace(/\.jsonl$/,'')+'-workers.jsonl'));}catch(error){if(error.code!=='ENOENT'){observer.emit('worker_diagnostics_copy_failed',{code:error.code??'ERROR'});code=1;}}
 console.log(JSON.stringify({component:'integration-timing',...probe}));try{await admin?.end();}catch(error){observer.emit('admin_close_failed',{code:error.code??error.name});code=1;}try{
  await cleanupOwned(project,ownedRunContainers,builtImage,{execute,down:()=>docker(['down','--volumes','--remove-orphans']),removeDirectory:()=>rm(directory,{recursive:true,force:true}),emit:observer.emit});
  console.log(JSON.stringify({component:'integration-runner',project,outcome:'cleaned_up'}));
 }finally{await rm(directory,{recursive:true,force:true});observer.close();}
}
process.exitCode=code;
