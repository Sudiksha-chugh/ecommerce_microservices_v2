// Portable entry point. Preparation is read-only apart from unique evidence files.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus,totalmem,freemem,platform} from 'node:os';
import {redactEvidence,sanitizeEvidence} from './verification-harness.mjs';
import {verifySnapshot,sourceRevision} from './verification-snapshot.mjs';
const execute=promisify(execFile),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const options=process.argv.slice(2);
if(options.some(arg=>!['--prepare-only','--sanitize-only'].includes(arg))||options.length>1)throw new Error('Usage: node scripts/verify-phase16.mjs [--prepare-only | --sanitize-only]');
if(process.versions.node.split('.')[0]!=='24')throw new Error('Verification requires Node 24; use the pinned container runtime 24.21.0');
process.chdir(root);
const parent=resolve(process.env.PHASE16_EVIDENCE_DIR??join(root,'verification-evidence'));
if(options.includes('--sanitize-only')){
 if(!process.env.PHASE16_SANITIZED_DIR)throw new Error('Sanitized evidence destination required');
 const target=resolve(process.env.PHASE16_SANITIZED_DIR);if(target===parent||target.startsWith(parent+'/'))throw new Error('Sanitized destination must be separate from raw evidence');
 console.log('Sanitized evidence files: '+await sanitizeEvidence(parent,target));process.exit(0);
}
await mkdir(parent,{recursive:true});const evidence=await mkdtemp(join(parent,'phase16-'));
console.log('Evidence directory: '+evidence);
const write=(name,value)=>writeFile(join(evidence,name),JSON.stringify(redactEvidence(value),null,2)+'\n',{mode:0o600});
let child,interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted=true;child?.kill(signal);});
async function run(args,env=process.env){
 if(interrupted)return 130;
 return new Promise((resolveRun,reject)=>{
  child=spawn(process.execPath,args,{cwd:root,env,stdio:['inherit','pipe','pipe']});
  for(const [stream,target] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]){
   let line='',oversized=false;
   stream.setEncoding('utf8');stream.on('data',data=>{
    for(const part of data.split(/(?<=\n)/)){
     if(!oversized)line+=part;if(line.length>65536){line='';oversized=true;}
     if(part.endsWith('\n')){target.write(oversized?'[oversized diagnostic line omitted]\n':redactEvidence(line));line='';oversized=false;}
    }
   });stream.on('end',()=>{if(line)target.write(redactEvidence(line));});
  }
  child.once('error',reject);child.once('exit',code=>{child=undefined;resolveRun(code??1);});
 });
}
const result={runtime:process.version,platform:platform(),gateA:'unexecuted',preparation:'incomplete',integration:'unexecuted',evidence};
try{
 if(process.env.PHASE16_SOURCE_IDENTITY!==undefined&&!/^[a-f0-9]{64}$/.test(process.env.PHASE16_SOURCE_IDENTITY))throw new Error('Expected source identity must be a full SHA256');
 result.revision=await sourceRevision(root,{expectedCommit:process.env.PHASE16_EXPECTED_COMMIT,workflowCommit:process.env.GITHUB_SHA,branch:process.env.GITHUB_REF_NAME});
 try{result.sourceIdentity=await verifySnapshot(root);}catch(error){if(error.code!=='ENOENT'||process.env.PHASE16_SOURCE_IDENTITY)throw error;}
 if(process.env.PHASE16_SOURCE_IDENTITY&&result.sourceIdentity!==process.env.PHASE16_SOURCE_IDENTITY)throw new Error('Expected working-tree snapshot identity unavailable or mismatched');
 result.gateA='running';
 const syntaxFiles=(await readdir(join(root,'scripts'))).filter(name=>name.endsWith('.mjs')).map(name=>'scripts/'+name).concat('vitest.harness.config.mjs');
 for(const args of [...syntaxFiles.map(file=>['--check',file]),['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'],['node_modules/vitest/vitest.mjs','run','--config','vitest.harness.config.mjs','--reporter=default','--reporter=json','--outputFile='+join(evidence,'A-harness.json')]]){
  const code=await run(args);if(code!==0)throw new Error('Gate A failed with exit '+code);
 }
 const harness=JSON.parse(await readFile(join(evidence,'A-harness.json'),'utf8'));
 if(harness.success!==true||harness.numPassedTests!==harness.numTotalTests||harness.numTotalTests<1||harness.numPendingTests!==0||harness.numFailedTestSuites!==0)throw new Error('Harness cases or hooks did not all pass');
 result.gateA='passed';
 result.compose=(await execute('docker',['compose','version','--short'],{timeout:5000})).stdout.trim();
 await execute('docker',['compose','-p','commerce-v2-stabilization-000000000000','-f','infrastructure/docker/compose.integration-test.yaml','config','--quiet'],{timeout:5000});
 result.preparation='complete';
 if(!options.includes('--prepare-only')){
  if(platform()!=='linux')throw new Error('Runtime gates require a dedicated Linux runner; preparation only is available on this host');
  const info=JSON.parse((await execute('docker',['info','--format','{{json .}}'],{timeout:5000,maxBuffer:100000})).stdout);
  const available=Number((await readFile('/proc/meminfo','utf8')).match(/^MemAvailable:\s+(\d+) kB$/m)?.[1])*1024;
  result.resources={hostCpus:cpus().length,hostTotalBytes:totalmem(),hostFreeBytes:freemem(),hostAvailableBytes:available,dockerCpus:info.NCPU,dockerTotalBytes:info.MemTotal,dockerOs:info.OSType};
  // Planning floor, not proof of responsiveness. Functional Gate B remains mandatory.
  if(info.OSType!=='linux'||info.NCPU<4||info.MemTotal<14*2**30||!Number.isFinite(available)||available<8*2**30)throw new Error('Runner capacity below planning floor: Linux, four CPUs, 14 GiB Docker memory and 8 GiB available host memory');
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('INTEGRATION_')||key==='NOTIFICATION_TEST_ADMIN_URL')delete env[key];
  Object.assign(env,{INTEGRATION_EXECUTION:'container',INTEGRATION_RECOVERY_STAGES:'true',INTEGRATION_LATENCY_STAGES:'true',INTEGRATION_STABILITY_STAGES:'true',INTEGRATION_STARTUP_AUDIT:'true',INTEGRATION_REPORT_DIR:evidence,INTEGRATION_DIAGNOSTICS_FILE:join(evidence,'runner-diagnostics.jsonl')});
  const code=await run(['scripts/integration-runner.mjs'],env);
  result.integration=code===0?'passed':'failed';if(code!==0)throw new Error('Runtime gate or owned cleanup failed with exit '+code);
 }
}catch(error){if(result.gateA==='running')result.gateA='failed';result.error=redactEvidence(error.message);process.exitCode=interrupted?130:1;console.error(result.error);}
finally{await write('execution.json',result);}
