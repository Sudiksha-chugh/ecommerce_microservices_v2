import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {brokerFunctionalReady,ownedProject,parseStartupRows,startupGuard,endpointValues,rewriteEndpoints,withExecutionMode,stabilityPlan,reportLocation,gatedStages,validateGateReport,retainReport,redactEvidence,cleanupOwned,sanitizeEvidence} from './verification-harness.mjs';
import {snapshotPathAllowed,snapshot,verifySnapshot,validateCommitIdentity} from './verification-snapshot.mjs';
import {observeStartup} from './integration-startup-observer.mjs';
const project='commerce-v2-stabilization-012345abcdef';
const ports={postgres:40001,searchPostgres:40002,amqp:40003,management:40004,redis:40005,elastic:40006};
const disposals=[];
afterEach(async()=>{vi.useRealTimers();for(const fn of disposals.splice(0))await fn();});
function broker(mode='ok'){
 const connection=new EventEmitter(),publisher=new EventEmitter(),consumer=new EventEmitter();let receive;
 publisher.assertQueue=vi.fn(async()=>{if(mode==='partial')throw new Error('topology failed');});
 publisher.deleteQueue=vi.fn(async()=>{if(mode==='cleanup')throw new Error('delete failed');});
 publisher.close=vi.fn(async()=>{});consumer.close=vi.fn(async()=>{});consumer.ack=vi.fn();
 consumer.consume=vi.fn(async(_queue,callback)=>{receive=callback;});
 publisher.sendToQueue=vi.fn((_queue,body,_props,confirm)=>{
  if(mode==='synchronous')throw new Error('publish failed');
  if(mode==='confirm-error'){confirm(new Error('negative confirm'));return;}
  if(mode==='confirm-timeout')return;
  confirm();
  if(mode==='lost'){connection.emit('close');return;}
  if(mode==='delivery-timeout')return;
  receive(mode==='cancel'?null:{content:mode==='payload'?Buffer.from('unexpected'):body});
 });
 connection.createConfirmChannel=vi.fn(async()=>publisher);connection.createChannel=vi.fn(async()=>consumer);
 connection.close=vi.fn(async()=>{if(mode==='close-stuck')await new Promise(()=>{});connection.emit('close');});
 connection.connection={stream:{destroy:vi.fn(()=>connection.emit('close'))}};
 return {connection,publisher,consumer,deliver:message=>receive(message)};
}
describe('functional broker readiness',()=>{
 it('requires confirms and validated manual delivery, then deletes exact owned resources',async()=>{
  const b=broker();await brokerFunctionalReady(b.connection,project);
  expect(b.consumer.ack).toHaveBeenCalledOnce();expect(b.publisher.deleteQueue).toHaveBeenCalledWith('test_012345abcdef.startup.probe');
  expect(b.consumer.close).toHaveBeenCalledOnce();expect(b.publisher.close).toHaveBeenCalledOnce();expect(b.connection.close).toHaveBeenCalledOnce();
 });
 it.each(['partial','confirm-error','synchronous','lost','cancel','payload','cleanup'])('retains %s failure and attempts closure',async mode=>{
  const b=broker(mode);await expect(brokerFunctionalReady(b.connection,project)).rejects.toBeInstanceOf(AggregateError);
  expect(b.connection.close).toHaveBeenCalledOnce();if(['payload','cancel','lost'].includes(mode))expect(b.consumer.ack).not.toHaveBeenCalled();
 });
 it.each(['confirm-timeout','delivery-timeout','close-stuck'])('bounds %s and clears timers without stale ACK',async mode=>{
  vi.useFakeTimers();const b=broker(mode);const result=expect(brokerFunctionalReady(b.connection,project)).rejects.toBeInstanceOf(AggregateError);
  await vi.advanceTimersByTimeAsync(30000);await result;expect(vi.getTimerCount()).toBe(0);
  const previous=b.consumer.ack.mock.calls.length;b.deliver({content:Buffer.from('owned readiness')});expect(b.consumer.ack).toHaveBeenCalledTimes(previous);
 });
 it('rejects foreign ownership before opening any channel',async()=>{const b=broker();await expect(brokerFunctionalReady(b.connection,'development')).rejects.toThrow('Unowned');expect(b.connection.createConfirmChannel).not.toHaveBeenCalled();});
});
describe('startup and mode guards',()=>{
 it('enforces a container deadline even when the enclosing session runs on host',async()=>{
  vi.useFakeTimers();const kill=vi.fn(),guard=startupGuard(false,kill);await vi.advanceTimersByTimeAsync(120000);expect(kill).toHaveBeenCalledOnce();expect(guard.expired).toBe(true);
 });
 it('clears a start guard only after a real StartedAt timestamp',async()=>{
  vi.useFakeTimers();const kill=vi.fn(),guard=startupGuard(false,kill);guard.observe({StartedAt:'0001-01-01T00:00:00Z'});await vi.advanceTimersByTimeAsync(1000);guard.observe({StartedAt:'2026-01-01T00:00:00Z'});await vi.advanceTimersByTimeAsync(120000);expect(kill).not.toHaveBeenCalled();expect(guard.expired).toBe(false);
 });
 it('allocates no container timer for host execution',()=>{vi.useFakeTimers();const guard=startupGuard(true,vi.fn());expect(vi.getTimerCount()).toBe(0);guard.close();});
 it('parses selective JSON rows and rejects mixed ownership or missing services',()=>{
  const rows=['postgres','rabbitmq'].map(service=>({Name:'/'+project+'-'+service+'-1',Project:project,State:{}}));const text=rows.map(row=>JSON.stringify(row)).join('\n');expect(parseStartupRows(text,project).broker.Name).toContain('rabbitmq');rows[0].Project='foreign';expect(()=>parseStartupRows(rows.map(JSON.stringify).join('\n'),project)).toThrow();expect(()=>parseStartupRows('{}',project)).toThrow();
 });
 it('rejects unsafe projects and mapped ports',()=>{expect(()=>ownedProject('shared')).toThrow();expect(()=>endpointValues(true,{...ports,postgres:0})).toThrow();});
 it('switches host/container endpoints without changing credentials and restores after failure',async()=>{
  const directory=await mkdtemp(join(tmpdir(),project+'-'));disposals.push(()=>rm(directory,{recursive:true,force:true}));
  for(const name of Object.keys(endpointValues(true,ports)))await writeFile(join(directory,name),'PASSWORD=keep-me\nFLAG=false\n');
  await rewriteEndpoints(directory,true,ports);expect(parseEnv(await readFile(join(directory,'.env'),'utf8')).PGPORT).toBe('40001');
  await expect(withExecutionMode(true,false,mode=>rewriteEndpoints(directory,mode,ports),async()=>{expect(parseEnv(await readFile(join(directory,'.env.search-test'),'utf8')).PGPORT).toBe('5441');throw new Error('gate failed');})).rejects.toThrow('gate failed');
  const env=parseEnv(await readFile(join(directory,'.env'),'utf8'));expect(env).toMatchObject({PASSWORD:'keep-me',FLAG:'false',PGPORT:'40001'});
 });
 it('retains both a stage error and restoration error',async()=>{await expect(withExecutionMode(true,false,async mode=>{if(mode)throw new Error('restore');},async()=>{throw new Error('stage');})).rejects.toMatchObject({errors:[expect.objectContaining({message:'stage'}),expect.objectContaining({message:'restore'})]});});
 it('cannot rewrite development env paths',async()=>{await expect(rewriteEndpoints('/tmp/development',true,ports)).rejects.toThrow('non-owned');});
});
describe('gate ordering and independent reports',()=>{
 it('runs the exact ordered plan and reports independently on failure',async()=>{
  const plan=stabilityPlan(),seen=[],recorded=[];const code=await gatedStages(plan,async stage=>{seen.push(stage.name);return stage.name==='E-search-run1'?7:0;},{record:async(stage,status)=>recorded.push([stage.name,status])});
  expect(code).toBe(7);expect(seen).toEqual(plan.slice(0,5).map(stage=>stage.name));expect(recorded.at(-1)).toEqual(['E-search-run1',7]);
  const locations=plan.map(stage=>reportLocation(stage,'/evidence','/output',true).target);expect(new Set(locations).size).toBe(plan.length);expect(reportLocation(plan[2],'/evidence','/output',false).output).toBe('/integration-output/C-messaging-container.json');
  for(const stage of plan.slice(4))expect(stage.files.some(arg=>arg.includes('testNamePattern'))).toBe(false);
 });
 it('stops on a rejected gate and retains its original error',async()=>{
  const error=new Error('partial startup'),run=vi.fn().mockRejectedValue(error),record=vi.fn();await expect(gatedStages(stabilityPlan(),run,{record})).rejects.toBe(error);expect(run).toHaveBeenCalledOnce();expect(record).toHaveBeenCalledWith(expect.any(Object),1,error);
 });
 it('does not launch gates after an interruption',async()=>{const run=vi.fn();expect(await gatedStages(stabilityPlan(),run,{interrupted:()=>true})).toBe(130);expect(run).not.toHaveBeenCalled();});
 it('rejects false green reports with skipped cases or failed setup/teardown',()=>{
  const green={success:true,numTotalTests:10,numPassedTests:10,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0};validateGateReport({name:'E-search-run1'},green);
  expect(()=>validateGateReport({name:'E-search-run1'},{...green,numPassedTests:9,numPendingTests:1})).toThrow();expect(()=>validateGateReport({name:'E-search-run1'},{...green,numFailedTestSuites:1})).toThrow();
  validateGateReport({name:'D-search-targeted'},{...green,numTotalTests:80,numPassedTests:7,numPendingTests:73});expect(()=>validateGateReport({name:'D-search-targeted'},{...green,numPassedTests:0})).toThrow();
  expect(()=>validateGateReport({probe:'latency'},{runtime:'v24.21.0',setup:'passed',assertions:'passed',cleanup:'failed'})).toThrow();
 });
 it('retains counts/error context while removing credentials from artifacts',async()=>{
  const directory=await mkdtemp(join(tmpdir(),project+'-'));disposals.push(()=>rm(directory,{recursive:true,force:true}));const source=join(directory,'raw.json'),target=join(directory,'public.json');
  await writeFile(source,JSON.stringify({numFailedTests:1,password:'secret-value',failure:'postgresql://test:password@127.0.0.1/db failed; permission denied'}));await retainReport(source,target);const saved=JSON.parse(await readFile(target,'utf8'));expect(saved.numFailedTests).toBe(1);expect(saved.failure).toContain('permission denied');expect(JSON.stringify(saved)).not.toContain('secret-value');expect(saved.failure).not.toContain(':password@');expect(redactEvidence('a'.repeat(48))).toBe('<redacted>');
 });
});
describe('bounded startup diagnostics',()=>{
 it('validates ownership before any exec and bounds failed collection',async()=>{
  const executeCommand=vi.fn().mockResolvedValue({stdout:[{Name:'/'+project+'-postgres-1',Project:'foreign'},{Name:'/'+project+'-rabbitmq-1',Project:project}].map(JSON.stringify).join('\n')}),emit=vi.fn();
  const close=observeStartup(project,emit,{executeCommand,maxSamples:1,scheduleTimer:false});await close();expect(executeCommand.mock.calls.every(([,args])=>args[0]==='inspect'||args[0]==='logs')).toBe(true);expect(emit).toHaveBeenCalledWith('startup_observer_unavailable',expect.any(Object));expect(executeCommand).toHaveBeenCalledTimes(2);
 });
 it('retains startup fields and sanitized node metrics under a fixed response budget',async()=>{
  const rows=['postgres','rabbitmq'].map(service=>({Name:'/'+project+'-'+service+'-1',Project:project,Created:'created',State:{Running:true,StartedAt:'started',Health:{Status:'healthy',Log:[]}},Ports:{'15672/tcp':[{HostIp:'127.0.0.1',HostPort:'41000'}],'5672/tcp':[{HostIp:'127.0.0.1',HostPort:'41001'}]}}));
  const executeCommand=vi.fn(async(_cmd,args,options)=>{expect(options.timeout).toBe(5000);expect(options.maxBuffer).toBe(24000);return {stdout:args[0]==='inspect'?rows.map(JSON.stringify).join('\n'):args[0]==='stats'?'{}':'ready'};});
  const emit=vi.fn(),connectAmqp=vi.fn(async()=>({on:()=>{},close:async()=>{},connection:{stream:{destroy:()=>{}}}}));
  const close=observeStartup(project,emit,{executeCommand,maxSamples:1,scheduleTimer:false,connectAmqp,fetchRequest:async()=>({status:200,ok:true,json:async()=>[{running:true,mem_alarm:false,password:'must-not-log'}]})});await close();
  expect(emit).toHaveBeenCalledWith('rabbit_startup_state',expect.objectContaining({created:'created',running:true}));expect(emit).toHaveBeenCalledWith('rabbit_startup_amqp',expect.objectContaining({ready:true}));expect(JSON.stringify(emit.mock.calls)).not.toContain('must-not-log');
 });
});

describe('partial startup cleanup',()=>{
 it('still attempts Compose, image and temporary cleanup after a foreign label is rejected',async()=>{
  const execute=vi.fn(async(_file,args)=>{if(args[0]==='inspect')return {stdout:JSON.stringify({'com.docker.compose.project':'foreign'})};return {stdout:''};}),down=vi.fn(async()=>{throw new Error('down failed');}),removeDirectory=vi.fn(async()=>{});
  await expect(cleanupOwned(project,[project+'-runner-abc'],project+'-test-runner',{execute,down,removeDirectory})).rejects.toMatchObject({errors:[expect.objectContaining({message:'Refusing unowned runner cleanup'}),expect.objectContaining({message:'down failed'})]});
  expect(execute.mock.calls.some(([,args])=>args[0]==='rm')).toBe(false);expect(execute).toHaveBeenCalledWith('docker',['image','rm',project+'-test-runner'],expect.any(Object));expect(down).toHaveBeenCalledOnce();expect(removeDirectory).toHaveBeenCalledOnce();
 });
 it('accepts missing partial-start resources and deletes only verified owned containers',async()=>{
  const execute=vi.fn(async(_file,args)=>{if(args.at(-1).endsWith('missing'))throw Object.assign(new Error('missing'),{stderr:'No such container'});return {stdout:JSON.stringify({'com.docker.compose.project':project,'com.docker.compose.service':'test-runner'})};}),down=vi.fn(async()=>{}),removeDirectory=vi.fn(async()=>{});
  await cleanupOwned(project,[project+'-runner-missing',project+'-runner-owned'],undefined,{execute,down,removeDirectory});expect(execute).toHaveBeenCalledWith('docker',['rm','-f',project+'-runner-owned'],expect.any(Object));expect(removeDirectory).toHaveBeenCalledOnce();
 });
});

describe('portable source snapshot',()=>{
 it('retains the Redis Lua runtime asset and loads it from an extracted snapshot',async()=>{
  const execute=promisify(execFile),directory=await mkdtemp(join(tmpdir(),project+'-'));disposals.push(()=>rm(directory,{recursive:true,force:true}));
  const source=join(directory,'repo'),target=join(directory,'extracted'),asset='packages/rate-limiting/src/scripts/token-bucket.lua';await mkdir(join(source,'packages/rate-limiting/src/scripts'),{recursive:true});await mkdir(join(source,'scripts'));await mkdir(target);await execute('git',['init','--quiet',source]);
  const lua=await readFile(new URL('../'+asset,import.meta.url),'utf8');await writeFile(join(source,asset),lua);
  await writeFile(join(source,'scripts/load.mjs'),"import {readFileSync} from 'node:fs';process.stdout.write(readFileSync(new URL('../"+asset+"',import.meta.url),'utf8'));\n");
  const output=join(directory,'source.tar.gz');const result=await snapshot(source,output);await execute('tar',['-xzf',output,'-C',target]);expect(result.files).toBe(2);expect(await verifySnapshot(target)).toBe(result.identity);expect((await execute(process.execPath,[join(target,'scripts/load.mjs')])).stdout).toBe(lua);
 });
 it('copies uncommitted source exactly, omits env files, rejects overwrite and detects tampering',async()=>{
  const execute=promisify(execFile),directory=await mkdtemp(join(tmpdir(),project+'-'));
  disposals.push(()=>rm(directory,{recursive:true,force:true}));const source=join(directory,'repo'),target=join(directory,'extracted');await mkdir(source);await mkdir(target);
  await execute('git',['init','--quiet',source]);await mkdir(join(source,'scripts'));
  await writeFile(join(source,'scripts','fixture.mjs'),'export const value=42;\n');await writeFile(join(source,'.env'),'PASSWORD=personal-development-secret\n');
  const output=join(directory,'source.tar.gz'),result=await snapshot(source,output);await execute('tar',['-xzf',output,'-C',target]);
  expect((await execute('tar',['-tzf',output])).stdout).not.toContain('._');
  expect(result.files).toBe(1);expect(await verifySnapshot(target)).toBe(result.identity);await expect(readFile(join(target,'.env'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(snapshot(source,output)).rejects.toMatchObject({code:'EEXIST'});await writeFile(join(target,'scripts','extra.mjs'),'extra');await expect(verifySnapshot(target)).rejects.toThrow('Unexpected snapshot source');await rm(join(target,'scripts','extra.mjs'));await writeFile(join(target,'scripts','fixture.mjs'),'changed');await expect(verifySnapshot(target)).rejects.toThrow('Snapshot file mismatch');
 });
 it('includes untracked implementation and lockfiles while excluding development data',()=>{
  for(const path of ['apps/search-service/src/app.ts','packages/messaging/package.json','package-lock.json','infrastructure/docker/integration-test.Dockerfile','.env.search.example','.github/workflows/phase16-verification.yml'])expect(snapshotPathAllowed(path)).toBe(true);
  for(const path of ['.env','.env.search','apps/search-service/.env','data/dev.sql','apps/search-service/data/dev.json','node_modules/pkg/index.ts','.git/config','docs/phase-16-results.json'])expect(snapshotPathAllowed(path)).toBe(false);
 });
});

describe('approved revision identity',()=>{
 it('requires the checkout and workflow to equal the approved commit',()=>{
  const expected='a'.repeat(40);validateCommitIdentity(expected,expected,expected);
  for(const [actual,approved,workflow] of [[expected,undefined,expected],['b'.repeat(40),expected,expected],[expected,expected,'b'.repeat(40)]])expect(()=>validateCommitIdentity(actual,approved,workflow)).toThrow('mismatched');
 });
});
describe('upload evidence boundary',()=>{
 it('retains failure counts and sanitizes JSON/JSONL while omitting env/archive files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),project+'-'));disposals.push(()=>rm(directory,{recursive:true,force:true}));const source=join(directory,'raw'),target=join(directory,'safe');await mkdir(source);
  await writeFile(join(source,'failure.json'),JSON.stringify({numFailedTests:1,cookie:'session-secret',requestPayload:{personal:'payload'},error:'Redis rediss://user:password@host; Authorization: Bearer live.token'}));
  await writeFile(join(source,'diagnostics.jsonl'),JSON.stringify({operation:'failure',message:'PASSWORD=live-password'})+'\n');await writeFile(join(source,'.env'),'PASSWORD=live-password');await writeFile(join(source,'archive.tar.gz'),'private');
  expect(await sanitizeEvidence(source,target)).toBe(2);const report=JSON.parse(await readFile(join(target,'failure.json'),'utf8'));expect(report.numFailedTests).toBe(1);expect(report.cookie).toBe('<redacted>');expect(report.requestPayload).toBe('<redacted>');expect(JSON.stringify(report)).not.toMatch(/session-secret|personal|:password@|live.token/);
  expect(await readFile(join(target,'diagnostics.jsonl'),'utf8')).not.toContain('live-password');await expect(readFile(join(target,'.env'))).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(join(target,'archive.tar.gz'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(sanitizeEvidence(source,target)).rejects.toMatchObject({code:'EEXIST'});
 });
 it('rejects malformed evidence instead of uploading raw text',async()=>{
  const directory=await mkdtemp(join(tmpdir(),project+'-'));disposals.push(()=>rm(directory,{recursive:true,force:true}));const source=join(directory,'raw');await mkdir(source);await writeFile(join(source,'broken.json'),'not safe JSON');await expect(sanitizeEvidence(source,join(directory,'safe'))).rejects.toBeInstanceOf(SyntaxError);
 });
});
