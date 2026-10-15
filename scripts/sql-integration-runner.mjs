import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {readTestEvidence} from './verification-test-evidence.mjs';
const execute=promisify(execFile),project='commerce-v2-sql-'+randomBytes(6).toString('hex'),directory=await mkdtemp(join(tmpdir(),project+'-')),password=randomBytes(32).toString('hex');
const output=resolve(process.env.SQL_VERIFICATION_REPORT_DIR??join(tmpdir(),project+'-report'));await mkdir(output,{recursive:true});
const report={project,passed:false,cleanup:false};let admin,started=false,child;
const docker=async args=>(await execute('docker',args,{timeout:60000,maxBuffer:10000})).stdout.trim();
const stop=()=>child?.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 if(!process.version.startsWith('v24.'))throw new Error('Node 24 required');
 await writeFile(join(directory,'postgres.env'),'POSTGRES_USER=phase18_fixture\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD='+password+'\n',{mode:0o600});
 started=true;await docker(['run','-d','--name',project,'--label','com.ecommerce.phase18.owner='+project,'--memory','256m','--cpus','1','--shm-size','16m','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=128m','--env-file',join(directory,'postgres.env'),'-p','127.0.0.1::5432','postgres:17','-c','shared_buffers=16MB','-c','max_connections=12']);
 const port=Number((await docker(['port',project,'5432/tcp'])).split(':').at(-1));
 admin=new pg.Pool({host:'127.0.0.1',port,user:'phase18_fixture',password,database:'postgres',max:1,connectionTimeoutMillis:500,statement_timeout:2000});admin.on('error',()=>{});
 const deadline=Date.now()+60000;let ready=false;while(Date.now()<deadline){try{const result=await admin.query('SELECT current_user,current_database()');if(result.rows[0].current_user!=='phase18_fixture'||result.rows[0].current_database!=='postgres')throw new Error('Unexpected fixture identity');ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}if(!ready)throw new Error('Owned PostgreSQL readiness failed');
 const file=join(directory,'fixture.json');await writeFile(file,JSON.stringify({project,host:'127.0.0.1',port,user:'phase18_fixture',password,database:'postgres'}),{mode:0o600});
 const status=await new Promise(resolve=>{child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.sql-integration.config.mjs','--reporter=json','--outputFile='+join(directory,'tests.json')],{stdio:'inherit',env:{...process.env,PHASE18_PG_FIXTURE_FILE:file}});child.once('exit',resolve);child.once('error',()=>resolve(1));});
 const evidence=await readTestEvidence(join(directory,'tests.json'));report.tests=evidence;report.passed=status===0&&evidence.success===true&&evidence.counts.numTotalTests>0&&evidence.counts.numFailedTests===0&&evidence.counts.numPendingTests===0&&evidence.counts.numTodoTests===0&&evidence.counts.numFailedTestSuites===0&&evidence.unexecuted.length===0;
 if(!report.passed)process.exitCode=1;
 if(report.passed&&process.env.SQL_RUN_PERFORMANCE==='true'){const benchmark=join(output,'sql-performance.json');await new Promise((resolve,reject)=>{child=spawn(process.execPath,['--import','tsx','scripts/sql-benchmark.mjs'],{stdio:'inherit',env:{...process.env,PHASE18_PG_FIXTURE_FILE:file,SQL_BENCHMARK_OUTPUT:benchmark}});child.once('exit',code=>code===0?resolve():reject(new Error('Benchmark failed')));child.once('error',reject);});report.performance=JSON.parse(await readFile(benchmark,'utf8'));if(!report.performance.passed)throw new Error('Benchmark failed');}
}catch{report.passed=false;report.error='isolated_sql_verification_failed';process.exitCode=1;}
finally{
 await admin?.end().catch(()=>{});
 if(started){try{const labels=JSON.parse(await docker(['inspect','--format','{{json .Config.Labels}}',project]));if(labels['com.ecommerce.phase18.owner']!==project)throw new Error('Ownership mismatch');await docker(['rm','-f',project]);if(await docker(['ps','-aq','--filter','label=com.ecommerce.phase18.owner='+project]))throw new Error('Owned container remains');report.cleanup=true;}catch{report.cleanup=false;process.exitCode=1;}}
 await rm(directory,{recursive:true,force:true});await writeFile(join(output,'sql-integration.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({component:'sql-integration',passed:report.passed,cleanup:report.cleanup,report:join(output,'sql-integration.json')}));
}
