import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,mkdir,rm,readFile,readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const execute=promisify(execFile),project='commerce-v2-observability-static-'+randomBytes(6).toString('hex'),directory=await mkdtemp(join(tmpdir(),project+'-'));
const env={...process.env,OBS_GRAFANA_PASSWORD_FILE:join(directory,'password')};await writeFile(env.OBS_GRAFANA_PASSWORD_FILE,randomBytes(24).toString('hex'),{mode:0o444});
const report={project,passed:false,checks:[],cleanup:true},owned=new Set();
try{
 await execute('docker',['compose','-p',project,'-f','compose.observability.yaml','--profile','observability','config','--quiet'],{env,timeout:10000});report.checks.push('opt-in Compose parses');
 for(const [name,image,entrypoint,args,config] of [
 ['collector','otel/opentelemetry-collector-contrib:0.162.0',undefined,['validate','--config=/etc/config.yaml'],'collector.yaml'],
 ['prometheus','prom/prometheus:v3.13.4','/bin/promtool',['check','config','/etc/config.yaml'],'prometheus.yaml']]){
  console.log(JSON.stringify({component:'observability-static',stage:'validating',name,image}));
  const container=project+'-'+name;owned.add(container);const result=await execute('docker',['run','--rm','--name',container,'--label','com.ecommerce.phase17.owner='+project,'--network','none','--memory','512m','--cpus','1','-v',resolve('infrastructure/observability/'+config)+':/etc/config.yaml:ro',...(entrypoint?['--entrypoint',entrypoint]:[]),image,...args],{timeout:240000,killSignal:'SIGKILL',maxBuffer:10000});report.checks.push({name,image,passed:true,output:(result.stdout+result.stderr).trim()});
 }
 for(const file of await readdir('infrastructure/observability/grafana/dashboards')){const dashboard=JSON.parse(await readFile('infrastructure/observability/grafana/dashboards/'+file,'utf8'));if(!dashboard.uid||!dashboard.panels.length||dashboard.panels.some(panel=>panel.datasource?.uid!=='prometheus'))throw new Error('Invalid dashboard '+file);report.checks.push({name:'dashboard-structure',file,panels:dashboard.panels.length});}
 report.passed=true;
}catch(error){report.error=error.message;report.killed=error.killed;report.signal=error.signal;process.exitCode=1;}
finally{
 for(const container of owned)try{const result=await execute('docker',['ps','-aq','--filter','name=^/'+container+'$'],{timeout:10000});if(result.stdout.trim())await execute('docker',['rm','-f',container],{timeout:30000});}catch(error){report.cleanup=false;report.cleanupError=error.message;process.exitCode=1;}
 await rm(directory,{recursive:true,force:true});const output=resolve(process.env.OBSERVABILITY_REPORT_DIR??'/tmp/commerce-v2-observability-static');await mkdir(output,{recursive:true});await writeFile(join(output,'static.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({component:'observability-static',passed:report.passed,cleanup:report.cleanup,report:join(output,'static.json')}));
}
