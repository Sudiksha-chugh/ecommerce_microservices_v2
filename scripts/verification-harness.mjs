import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {parseEnv} from 'node:util';

export function ownedProject(project){
 if(!/^commerce-v2-stabilization-[a-f0-9]{12}$/.test(project))throw new Error('Unowned verification project');
 return project;
}
export function parseStartupRows(output,project){
 ownedProject(project);
 const rows=output.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const find=service=>rows.find(row=>row.Name==='/'+project+'-'+service+'-1');
 if(rows.length!==2||rows.some(row=>row.Project!==project)||!find('postgres')||!find('rabbitmq'))throw new Error('Unexpected startup ownership');
 return {broker:find('rabbitmq'),postgres:find('postgres')};
}
export function containerHasStarted(state){return !!state.StartedAt&&!state.StartedAt.startsWith('0001-');}
export function startupGuard(executionHost,onDeadline,{setTimeout:timer=setTimeout,clearTimeout:clear=clearTimeout}={}){
 let started=executionHost,expired=false;
 const id=executionHost?undefined:timer(()=>{if(!started){expired=true;onDeadline();}},120000);
 return {observe:state=>{if(containerHasStarted(state)){started=true;clear(id);}},get expired(){return expired;},close:()=>clear(id)};
}
export async function brokerFunctionalReady(connection,project,{budgetMs=30000,confirmMs=3000}={}){
 ownedProject(project);
 const queue='test_'+project.split('-').at(-1)+'.startup.probe';
 let publisher,consumer,primary,failDelivery,live=true;const errors=[];
 const lost=()=>failDelivery?.(new Error('Owned broker connection closed before delivery'));
 connection.once('close',lost);
 let rejectDeadline;
 const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
 const timer=setTimeout(()=>{
  live=false;const error=new Error('Owned AMQP readiness deadline');
  connection.connection.stream.destroy(error);
  rejectDeadline(new AggregateError([...(primary?[primary]:[]),...errors,error],'Owned broker readiness or cleanup failed'));
 },budgetMs);
 const graceful=(async()=>{
  try{
   publisher=await connection.createConfirmChannel();publisher.on('error',()=>{});
   consumer=await connection.createChannel();consumer.on('error',()=>{});
   await publisher.assertQueue(queue,{durable:true,arguments:{'x-queue-type':'quorum'}});
   let delivered;const delivery=new Promise((resolve,reject)=>{delivered=resolve;failDelivery=reject;});void delivery.catch(()=>{});
   await consumer.consume(queue,message=>{
    if(!live)return;
    if(!message||message.content.toString()!=='owned readiness'){failDelivery(new Error('Owned broker delivery not usable'));return;}
    consumer.ack(message);delivered();
   },{noAck:false});
   await new Promise((resolve,reject)=>{
    const confirm=setTimeout(()=>reject(new Error('Owned publisher confirm deadline')),confirmMs);
    try{publisher.sendToQueue(queue,Buffer.from('owned readiness'),{persistent:true},error=>{clearTimeout(confirm);error?reject(error):resolve();});}
    catch(error){clearTimeout(confirm);reject(error);}
   });
   await delivery;
  }catch(error){primary=error;}
  finally{
   live=false;
   if(publisher)try{await publisher.deleteQueue(queue);}catch(error){errors.push(error);}
   if(consumer)try{await consumer.close();}catch(error){errors.push(error);}
   if(publisher)try{await publisher.close();}catch(error){errors.push(error);}
   try{await connection.close();}catch(error){errors.push(error);}
  }
  if(primary||errors.length)throw new AggregateError([...(primary?[primary]:[]),...errors],'Owned broker readiness or cleanup failed');
 })();
 try{await Promise.race([graceful,deadline]);}finally{live=false;clearTimeout(timer);connection.off('close',lost);}
}
export function endpointValues(host,ports){
 for(const key of ['postgres','searchPostgres','amqp','management','redis','elastic'])if(!Number.isInteger(ports[key])||ports[key]<1||ports[key]>65535)throw new Error('Invalid mapped test port');
 const selected=host?ports:{postgres:5432,searchPostgres:5441,amqp:5672,management:15672,redis:6379,elastic:9200};
 return {'.env':{PGPORT:selected.postgres},...Object.fromEntries(['auth','orders','inventory','payments','mock'].map(service=>[service==='mock'?'.env.mock-provider':'.env.'+service,{[service.toUpperCase()+'_PGPORT']:selected.postgres}])),'.env.cart':{CART_TEST_REDIS_URL:'redis://127.0.0.1:'+selected.redis+'/15'},'.env.messaging':{RABBITMQ_AMQP_PORT:selected.amqp,RABBITMQ_MANAGEMENT_PORT:selected.management},'.env.search-test':{PGPORT:selected.searchPostgres,AMQP_PORT:selected.amqp,MANAGEMENT_PORT:selected.management,ELASTIC_PORT:selected.elastic}};
}
export async function rewriteEndpoints(directory,host,ports){
 if(!/^commerce-v2-stabilization-[a-f0-9]{12}-/.test(basename(directory)))throw new Error('Refusing non-owned environment directory');
 for(const [name,values] of Object.entries(endpointValues(host,ports))){
  const current=parseEnv(await readFile(join(directory,name),'utf8'));
  await writeFile(join(directory,name),Object.entries({...current,...values}).map(([k,v])=>`${k}=${v}\n`).join(''),{mode:0o600});
 }
}
export const targetedSearchPattern='fixture cleanup regression|Search cannot connect to the private Catalog database|concurrent consumers cannot roll back a newer version|replaying an old event after loss of a physical index|inbox commit failure after Elasticsearch success';
export function stabilityPlan(){return [
 {name:'B-readiness',probe:'latency'},
 {name:'C-messaging-host',files:['packages/messaging/test'],host:true},
 {name:'C-messaging-container',files:['packages/messaging/test'],host:false},
 {name:'D-search-targeted',files:['apps/search-service/test/integration.test.ts','--testNamePattern='+targetedSearchPattern]},
 {name:'E-search-run1',files:['apps/search-service/test']},
 {name:'F-search-run2',files:['apps/search-service/test']},
 {name:'G-regression-run1',files:[]},
 {name:'H-regression-run2',files:[]},
 ];}
export function reportLocation(stage,directory,outputDirectory,host){
 if(!/^(?:[A-H]|T)-[a-z0-9-]+$/.test(stage.name))throw new Error('Unsafe report name');
 return {target:join(directory,stage.name+'.json'),local:join(outputDirectory,stage.name+'.json'),output:host?join(outputDirectory,stage.name+'.json'):'/integration-output/'+stage.name+'.json'};
}
export async function gatedStages(stages,run,{interrupted=()=>false,record=async()=>{}}={}){
 for(const stage of stages){
  if(interrupted())return 130;
  try{const code=await run(stage);await record(stage,code);if(code!==0)return code;}
  catch(error){await record(stage,1,error);throw error;}
 }
 return 0;
}
export async function withExecutionMode(baseHost,stageHost,switchEndpoints,run){
 if(baseHost===stageHost)return run();
 let value,primary;
 try{await switchEndpoints(stageHost);value=await run();}catch(error){primary=error;}
 try{await switchEndpoints(baseHost);}catch(error){throw new AggregateError([...(primary?[primary]:[]),error],'Endpoint switch and restoration failed');}
 if(primary)throw primary;
 return value;
}
export function validateGateReport(stage,report){
 if(stage.probe){
  if(!/^v24\./.test(report.runtime)||report.setup!=='passed'||report.cleanup!=='passed'||(stage.probe!=='setup'&&report.assertions!=='passed'))throw new Error('Readiness probe or cleanup did not pass');
  return;
 }
 const targeted=stage.name==='D-search-targeted'||stage.name==='T-search-targeted';
 if(report.success!==true||!Number.isInteger(report.numTotalTests)||report.numTotalTests<1||report.numFailedTests!==0||report.numFailedTestSuites!==0||(!targeted&&report.numPendingTests!==0)||report.numPassedTests!==(targeted?7:report.numTotalTests))throw new Error('Gate report has failures, skipped or unexecuted cases');
}
export function redactEvidence(value){
 if(typeof value==='string')return value.replace(/((?:postgres(?:ql)?|amqps?|rediss?|https?):\/\/[^:\s/@]+:)[^@\s]+@/g,'$1<redacted>@').replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'$1 <redacted>').replace(/((?:[A-Z_]*(?:PASSWORD|TOKEN|SECRET|COOKIE)|Cookie|Set-Cookie)\s*[:=]\s*)[^\r\n]+/gi,'$1<redacted>').replace(/\b[a-f0-9]{48}\b/g,'<redacted>').replace(/isolated_[a-z_]+_only/g,'<redacted>');
 if(Array.isArray(value))return value.map(redactEvidence);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/password|secret|token|cookie|authorization|private.?key|request.?payload|request.?body/i.test(key)?'<redacted>':redactEvidence(item)]));
 return value;
}
// Upload only this separate, parsed and sanitized projection, never raw runner output.
export async function sanitizeEvidence(source,target){
 await mkdir(target,{recursive:true});let count=0;
 for(const entry of await readdir(source,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw new Error('Refusing evidence symlink');
  if(entry.isDirectory()){count+=await sanitizeEvidence(join(source,entry.name),join(target,entry.name));continue;}
  if(!/\.jsonl?$/.test(entry.name))continue;
  const content=await readFile(join(source,entry.name),'utf8');
  const sanitized=entry.name.endsWith('.jsonl')?content.split('\n').filter(Boolean).map(line=>JSON.stringify(redactEvidence(JSON.parse(line)))).join('\n'):JSON.stringify(redactEvidence(JSON.parse(content)),null,2);
  await writeFile(join(target,entry.name),sanitized+'\n',{mode:0o600,flag:'wx'});count++;
 }
 return count;
}
export async function retainReport(local,target){
 const report=JSON.parse(await readFile(local,'utf8'));
 await writeFile(target,JSON.stringify(redactEvidence(report),null,2)+'\n',{mode:0o600});
 return report;
}
// Attempt every owned cleanup phase even if partial startup or one phase fails.
export async function cleanupOwned(project,names,image,{execute,down,removeDirectory,emit=()=>{}}){
 ownedProject(project);const errors=[];
 try{
  for(const name of names)try{
   if(!name.startsWith(project+'-runner-'))throw new Error('Refusing foreign runner name');
   const labels=JSON.parse((await execute('docker',['inspect','--format','{{json .Config.Labels}}',name],{timeout:5000,maxBuffer:10000})).stdout);
   if(labels?.['com.docker.compose.project']!==project||labels?.['com.docker.compose.service']!=='test-runner')throw new Error('Refusing unowned runner cleanup');
   await execute('docker',['rm','-f',name],{timeout:10000,maxBuffer:10000});emit('owned_runner_cleanup',{name,outcome:'ok'});
  }catch(error){if(!/No such (object|container)/i.test(error.stderr??'')){errors.push(error);emit('owned_runner_cleanup',{name,outcome:'failed',code:error.code??error.name});}}
  try{await down();}catch(error){errors.push(error);}
  if(image)try{
   if(image!==project+'-test-runner')throw new Error('Refusing foreign image cleanup');
   await execute('docker',['image','rm',image],{timeout:10000,maxBuffer:10000});emit('owned_image_cleanup',{outcome:'ok',image});
  }catch(error){if(!error.stderr?.includes('No such image'))errors.push(error);}
 }finally{try{await removeDirectory();}catch(error){errors.push(error);}}
 if(errors.length)throw new AggregateError(errors,'Owned verification cleanup failed');
}
