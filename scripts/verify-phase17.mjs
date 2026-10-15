// Runs only an explicitly approved immutable Phase 17 snapshot on a dedicated Linux host.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {cpus,totalmem,platform} from 'node:os';
import {readTestEvidence} from './verification-test-evidence.mjs';
import {verifyPhase17Source} from './phase17-source.mjs';
import {validateCommitIdentity} from './verification-snapshot.mjs';
import {validateGateReport,redactEvidence} from './verification-harness.mjs';
const execute=promisify(execFile),root=resolve('.'),directory=resolve(process.env.PHASE17_EVIDENCE_DIR??'/tmp/phase17-evidence');
await mkdir(directory,{recursive:true,mode:0o700});
const report={status:'INCOMPLETE',stages:[],sourceIdentity:process.env.PHASE17_SOURCE_IDENTITY};let child,interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;child?.kill('SIGTERM');});
const verify=()=>verifyPhase17Source(root,process.env.PHASE17_SOURCE_IDENTITY);
async function run(name,args,extra={}){
 await verify();if(interrupted)throw new Error('Verification interrupted');const stage={name,status:'running',started:new Date().toISOString()};report.stages.push(stage);await save();
 try{await new Promise((done,fail)=>{child=spawn(process.execPath,args,{env:{...process.env,OTEL_ENABLED:'false',...extra},stdio:['ignore','pipe','pipe']});for(const [stream,target] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]){let line='';stream.setEncoding('utf8');stream.on('data',chunk=>{line+=chunk;if(line.length>65536)line='[oversized diagnostic omitted]\n';let end;while((end=line.indexOf('\n'))>=0){target.write(redactEvidence(line.slice(0,end+1)));line=line.slice(end+1);}});stream.on('end',()=>{if(line)target.write(redactEvidence(line));});}const timer=setTimeout(()=>child?.kill('SIGTERM'),5400000);child.once('error',error=>{clearTimeout(timer);fail(error);});child.once('exit',code=>{clearTimeout(timer);child=undefined;code===0?done():fail(new Error(name+' failed with exit '+code));});});await verify();stage.status='passed';}
 catch(error){const output=args.find(arg=>arg.startsWith('--outputFile='))?.slice('--outputFile='.length);if(output)try{stage.tests=await readTestEvidence(output);}catch(evidenceError){stage.testEvidenceUnavailable=evidenceError.code??evidenceError.name;}stage.status='failed';stage.error=redactEvidence(error.message);throw error;}finally{stage.finished=new Date().toISOString();await save();}
}
async function testReport(name,file,expected){const data=JSON.parse(await readFile(file,'utf8'));validateGateReport({name},data);if(expected&&data.numTotalTests!==expected)throw new Error(name+' test discovery changed unexpectedly');report.stages.find(s=>s.name===name).tests={total:data.numTotalTests,passed:data.numPassedTests,failed:data.numFailedTests,pending:data.numPendingTests,failedSuites:data.numFailedTestSuites};await save();return data;}
async function save(){await writeFile(join(directory,'stage-results.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
try{
 if(process.version!=='v24.21.0')throw new Error('Pinned Node 24.21.0 required');
 const commit=(await execute('git',['rev-parse','HEAD'],{timeout:5000})).stdout.trim();validateCommitIdentity(commit,process.env.PHASE17_EXPECTED_COMMIT,process.env.GITHUB_SHA);report.commit=commit;await verify();
 if(platform()!=='linux')throw new Error('Heavy verification requires dedicated Linux; local source preparation remains available');
 const info=JSON.parse((await execute('docker',['info','--format','{{json .}}'],{timeout:10000,maxBuffer:100000})).stdout),mem=await readFile('/proc/meminfo','utf8');
 const field=name=>Number(mem.match(new RegExp('^'+name+':\\s+(\\d+) kB$','m'))?.[1])*1024;
 report.capacity={hostCpus:cpus().length,hostTotalBytes:totalmem(),hostAvailableBytes:field('MemAvailable'),swapUsedBytes:field('SwapTotal')-field('SwapFree'),dockerMemoryBytes:info.MemTotal,dockerCpus:info.NCPU};
 const disk=(await execute('df',['-Pk',root],{timeout:5000})).stdout.trim().split('\n').at(-1).trim().split(/\s+/);report.capacity.diskAvailableBytes=Number(disk[3])*1024;if(!Number.isFinite(report.capacity.diskAvailableBytes)||report.capacity.diskAvailableBytes<12*2**30)throw new Error('Runner needs at least 12 GiB free disk for disposable images and evidence');
 const existing=(await execute('docker',['ps','-q'],{timeout:10000})).stdout.trim();if(existing)throw new Error('Dedicated runner must have no pre-existing running containers; none will be stopped');
 if(info.OSType!=='linux'||info.NCPU<4||info.MemTotal<14*2**30||field('MemAvailable')<8*2**30)throw new Error('Linux capacity floor: four CPUs, 14 GiB Docker memory and 8 GiB host MemAvailable');
 await save();await run('typecheck',['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json']);
 await run('compiled-preload',['scripts/observability-compiled-smoke.mjs']);
 await run('static-stack',['scripts/observability-static.mjs'],{OBSERVABILITY_REPORT_DIR:join(directory,'static')});
 for(const [name,args] of [['harness',['--config','vitest.harness.config.mjs']],['observability-unit',['packages/observability/test']],['disabled-focused',['apps/api-gateway/test','apps/search-service/test/unit.test.ts','packages/rate-limiting/test/unit.test.ts','packages/messaging/test/contracts.test.ts','packages/messaging/test/readiness.test.ts','packages/messaging/test/shutdown.test.ts','packages/messaging/test/raw-scenario.test.ts']]]){
  const path=join(directory,name+'.json');await run(name,['node_modules/vitest/vitest.mjs','run',...args,'--reporter=json','--outputFile='+path]);await testReport(name,path);
 }
 await run('five-live-proofs-and-collector-performance',['scripts/observability-runner.mjs'],{OBSERVABILITY_REPORT_DIR:join(directory,'live'),OBS_RUN_PERFORMANCE:'true'});
 const live=JSON.parse(await readFile(join(directory,'live/result.json'),'utf8'));if(live.passed!==true||live.cleanup!==true)throw new Error('Live proof or cleanup incomplete');
 const proofs=JSON.parse(await readFile(join(directory,'live/proof-tests.json'),'utf8'));validateGateReport({name:'five-proofs'},proofs);if(proofs.numTotalTests!==5)throw new Error('All five existing proof cases are required');report.proofs={total:5,passed:5};
 let fullCount;for(let iteration=1;iteration<=2;iteration++){
  const name='full-regression-'+iteration,path=join(directory,name+'.json');
  await run(name,['scripts/integration-runner.mjs','--reporter=json','--outputFile='+path],{INTEGRATION_EXECUTION:'host',INTEGRATION_REPEAT:'1',INTEGRATION_STARTUP_AUDIT:'true',INTEGRATION_DIAGNOSTICS_FILE:join(directory,name+'-diagnostics.jsonl')});
  const data=await testReport(name,path,fullCount);fullCount=data.numTotalTests;
 }
 report.status='COMPLETE';
}catch(error){report.error=redactEvidence(error.message);process.exitCode=1;}finally{await save();console.log(JSON.stringify({status:report.status,evidence:directory,error:report.error}));}
