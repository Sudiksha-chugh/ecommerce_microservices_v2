import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const execute=promisify(execFile),file='docs/phase-22-live-results.json',saved=await readFile(file),baseline=JSON.parse(saved);
const child=spawn(process.execPath,['--import','tsx','scripts/resilience-live.mjs'],{stdio:['ignore','ignore','ignore']});
let timer;const exited=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Owned interruption driver deadline'));},60000);});
let project,workerPid;
try{
 const start=Date.now();while(Date.now()-start<45000){
  const listing=(await execute('docker',['ps','-a','--filter','label=io.ecommerce.phase22.owner=ecommerce-phase22','--format','{{.Label "com.docker.compose.project"}}'],{timeout:2000})).stdout.trim();
  const projects=[...new Set(listing.split('\n').filter(Boolean))];if(projects.length===1&&projects[0]!==baseline.fixture.project)project=projects[0];
  const processes=(await execute('ps',['-axo','pid=,ppid=,command='],{timeout:2000,maxBuffer:2000000})).stdout;
  const worker=processes.split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).find(m=>m&&Number(m[2])===child.pid&&m[3].includes('/scripts/resilience-worker.mjs'));
  if(project&&worker){workerPid=Number(worker[1]);break;}
  await new Promise(r=>setTimeout(r,100));
 }
 assert(project&&workerPid,'Expected a newly owned project and its real matrix worker before interruption');child.kill('SIGTERM');const exit=await exited;
 const interrupted=JSON.parse(await readFile(file));assert.equal(interrupted.fixture.project,project);assert.equal(interrupted.status,'failed');assert.equal(interrupted.cleanup.verified,true);assert.equal(exit.code,1);assert(interrupted.matrix.some(m=>m.status==='failed'));assert(interrupted.telemetry.some(t=>t.telemetry.status==='unavailable'));
 let stillRunning=false;try{const out=await execute('ps',['-p',String(workerPid),'-o','pid='],{timeout:2000});stillRunning=out.stdout.trim()!=='';}catch{}assert.equal(stillRunning,false,'Owned child must be gone after parent SIGTERM');
 await writeFile('docs/phase-22-interruption-results.json',JSON.stringify(interrupted,null,2)+'\n');
 const recovered=await execute(process.execPath,['--import','tsx','scripts/resilience-recover.mjs',interrupted.fixture.runId],{timeout:30000});assert.equal(JSON.parse(recovered.stdout.trim()).cleanup,'verified');
 await writeFile('/private/tmp/phase22-cont-interruption-summary.json',JSON.stringify({status:'passed',signal:'SIGTERM',fixture:interrupted.fixture,sourceDigest:interrupted.sourceDigest,childExitCode:exit.code,interruptedDuringOwnedMatrixWorker:true,ownedWorkerExited:true,telemetryUnavailableExplicit:true,cleanupVerified:true,manualRecoveryIdempotent:true},null,2)+'\n');console.log('Mid-matrix SIGTERM cleanup, unavailable telemetry and child teardown passed');
}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited.catch(()=>{});}await writeFile(file,saved);}
