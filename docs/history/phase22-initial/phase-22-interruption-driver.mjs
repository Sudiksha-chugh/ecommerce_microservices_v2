import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const execute=promisify(execFile),file='docs/phase-22-live-results.json',saved=await readFile(file),baseline=JSON.parse(saved);
const child=spawn(process.execPath,['--import','tsx','scripts/resilience-live.mjs'],{stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log=(log+b).slice(-10000));child.stderr.on('data',b=>log=(log+b).slice(-10000));
let timer;const exited=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Interruption test hard deadline; manual recovery may be needed'));},60000);});
try{
 // Wait for the child to have actually created its own labeled containers.
 const start=Date.now();let project;
 while(Date.now()-start<20000){const out=(await execute('docker',['ps','-a','--filter','label=io.ecommerce.phase22.owner=ecommerce-phase22','--format','{{.Label "com.docker.compose.project"}}'],{timeout:2000})).stdout.trim();const projects=[...new Set(out.split('\n').filter(Boolean))];if(projects.length===1){project=projects[0];break;}await new Promise(r=>setTimeout(r,100));}
 assert(project&&project!==baseline.fixture.project,'A new isolated child project must exist before interruption');child.kill('SIGTERM');const exit=await exited;
 const interrupted=JSON.parse(await readFile(file));assert.equal(interrupted.fixture.project,project);assert.equal(interrupted.status,'failed');assert.equal(interrupted.cleanup.verified,true);assert.equal(exit.code,1);
 await copyFile(file,'docs/phase-22-interruption-results.json');
 const recovery=await execute(process.execPath,['--import','tsx','scripts/resilience-recover.mjs',interrupted.fixture.runId],{timeout:30000});assert.equal(JSON.parse(recovery.stdout.trim()).cleanup,'verified');
 await writeFile('/private/tmp/phase22-interruption-summary.json',JSON.stringify({status:'passed',signal:'SIGTERM',fixture:interrupted.fixture,childExitCode:exit.code,ownedResourcesExistedBeforeSignal:true,cleanupVerified:true,manualRecoveryIdempotent:true,sourceDigest:baseline.sourceDigest},null,2)+'\n');
 console.log('Live SIGTERM cleanup and idempotent manual recovery passed');
}finally{clearTimeout(timer);await writeFile(file,saved);}
