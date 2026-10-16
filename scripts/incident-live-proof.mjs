// Isolated synthetic observability proof. Never touches development stores or applications.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {reservePublishedPorts} from './observability-readiness.mjs';
import {initializeTelemetry} from '../packages/observability/bootstrap.mjs';
import {IncidentAnalysis} from '../packages/observability/src/incident/engine.ts';
import {defaultCollectors,metricTemplates} from '../packages/observability/src/incident/collectors.ts';
import {defaultLimits,reportSchema} from '../packages/observability/src/incident/schemas.ts';
const execute=promisify(execFile),project='commerce-v2-incident-'+randomBytes(6).toString('hex');
const directory=await mkdtemp(join(tmpdir(),project+'-')),output=resolve(process.env.INCIDENT_PROOF_DIR??join(tmpdir(),project+'-evidence'));
await mkdir(output,{recursive:true});
const password=randomBytes(24).toString('hex'),env={...process.env,OBS_GRAFANA_PASSWORD_FILE:join(directory,'grafana-password')};
await writeFile(env.OBS_GRAFANA_PASSWORD_FILE,password,{mode:0o444});
const base=['compose','-p',project,'-f','compose.observability.yaml','--profile','observability'];
const docker=async args=>(await execute('docker',[...base,...args],{env,timeout:120000,maxBuffer:200000})).stdout.trim();
const json=async(url,headers={})=>{const r=await fetch(url,{headers,signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('Live backend unavailable');return r.json();};
async function until(check){const end=Date.now()+120000;let error;while(Date.now()<end){try{return await check();}catch(e){error=e;await new Promise(r=>setTimeout(r,500));}}throw error;}
const result={project,passed:false,cleanup:false,checks:[]};
const stage=name=>{result.stage=name;console.log(JSON.stringify({component:'incident-live-proof',stage:name}));};let reservation,state,context;
try{
 if(!process.version.startsWith('v24.'))throw Error('Node 24 required');
 reservation=await reservePublishedPorts(['OTEL_HTTP_PORT','PROMETHEUS_PORT','TEMPO_PORT','GRAFANA_PORT']);Object.assign(env,reservation.ports);await reservation.release();stage('starting-backends');await docker(['up','-d']);stage('discovering-endpoints');
 const endpoint=async(name,port)=>'http://127.0.0.1:'+Number((await docker(['port',name,String(port)])).split(':').at(-1));
 const collector=await endpoint('otel-collector',4318),prometheus=await endpoint('prometheus',9090),tempo=await endpoint('tempo',3200),grafana=await endpoint('grafana',3000);
 stage('prometheus-ready');await until(()=>json(prometheus+'/api/v1/status/config'));stage('grafana-ready');await until(()=>json(grafana+'/api/health'));stage('tempo-ready');await until(async()=>{const r=await fetch(tempo+'/ready',{signal:AbortSignal.timeout(1000)});await r.body?.cancel();if(!r.ok)throw Error('Tempo not ready');});
 stage('verifying-dashboards');const auth={Authorization:'Basic '+Buffer.from('observability-admin:'+password).toString('base64')};
 const expected=(await readdir('infrastructure/observability/grafana/dashboards')).filter(f=>f.endsWith('.json')).length;
 const dashboards=await until(async()=>{const d=await json(grafana+'/api/search?type=dash-db',auth);if(d.length!==expected)throw Error('Dashboards not ready');return d;});
 let queries=0;for(const d of dashboards){const document=await json(grafana+'/api/dashboards/uid/'+encodeURIComponent(d.uid),auth);for(const panel of document.dashboard.panels)for(const target of panel.targets??[]){const response=await json(prometheus+'/api/v1/query?query='+encodeURIComponent(target.expr));if(response.status!=='success')throw Error('Dashboard expression invalid');queries++;}}
 result.checks.push({name:'existing-grafana-dashboards',passed:true,dashboards:dashboards.length,validQueries:queries,note:'Expression validity and provisioning only. Synthetic fixture does not populate every dashboard.'});
 stage('seeding-traces');const start=Date.now()-1000,traceId=randomBytes(16).toString('hex'),parent=randomBytes(8).toString('hex'),child=randomBytes(8).toString('hex');
 const nano=ms=>String(BigInt(ms)*1000000n);
 const trace={resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'orders-service'}}]},scopeSpans:[{scope:{name:'phase20-proof'},spans:[{traceId,spanId:parent,name:'synthetic checkout',kind:1,startTimeUnixNano:nano(start),endTimeUnixNano:nano(start+500),status:{code:2}}]}]},{resource:{attributes:[{key:'service.name',value:{stringValue:'payments-service'}}]},scopeSpans:[{scope:{name:'phase20-proof'},spans:[{traceId,spanId:child,parentSpanId:parent,name:'synthetic payment',kind:2,startTimeUnixNano:nano(start+10),endTimeUnixNano:nano(start+400),status:{code:2,message:'password=private-fixture'},attributes:[{key:'http.request.body',value:{stringValue:'customer@example.com'}}]}]}]}]};
 await until(async()=>{const r=await fetch(collector+'/v1/traces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(trace),signal:AbortSignal.timeout(2000)});await r.body?.cancel();if(!r.ok)throw Error('Collector unavailable');});
 stage('seeding-metrics');state=await initializeTelemetry({OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'orders-service',OTEL_EXPORTER_OTLP_ENDPOINT:collector,OTEL_METRIC_EXPORT_INTERVAL:'1000'});
 const {httpMetric,dependencyMetric,messagingMetric,observeBusiness}=await import('../packages/observability/src/metrics.ts');
 const emit=()=>{for(let i=0;i<20;i++){httpMetric('POST','/checkout',i%2?500:200,2);dependencyMetric('postgresql','SELECT','success',0.3);messagingMetric('retry','error');observeBusiness('order_failed','error');}};
 emit();await state.flush();
 // Produce multiple actual Prometheus scrapes for counter rates. No development data is used.
 for(let i=0;i<14;i++){await new Promise(r=>setTimeout(r,1000));emit();}
 await state.flush();
 const input={incidentId:'synthetic-live-proof',startTime:new Date(start-60000).toISOString(),endTime:new Date().toISOString(),services:['orders-service','payments-service'],traceId};
 const limits={...defaultLimits,backendTimeoutMs:3000,durationMs:20000,cacheEntries:0};context={prometheus,tempo,input};
 stage('collecting-evidence');const report=await until(async()=>{emit();await state.flush();input.endTime=new Date().toISOString();const r=await new IncidentAnalysis(defaultCollectors({prometheus,tempo},limits),limits).analyze(input);await writeFile(join(output,'last-incident-report.json'),JSON.stringify(r,null,2));if(!metricTemplates.every(t=>r.observations.some(e=>e.source==='metrics'&&e.signal===t.signal))||!r.observations.some(e=>e.source==='traces'))throw Error('All six live metric signals and trace evidence are not yet queryable');return r;});
 reportSchema.parse(report);if(!report.findings.length||!report.rootCauseHypotheses.length)throw Error('Live findings or evidence-backed hypotheses missing');
 if(report.status!=='partial'||report.coverage.logs!=='unavailable'||!report.dependencies.some(e=>e.kind==='observed'))throw Error('Live incident report did not preserve coverage or dependencies');
 if(/private-fixture|customer@example.com|http.request.body/.test(JSON.stringify(report)))throw Error('Sanitization failed');
 result.checks.push({name:'live-incident-collectors',passed:true,metrics:report.observations.filter(e=>e.source==='metrics').length,spans:report.observations.filter(e=>e.source==='traces').length,status:report.status});
 await writeFile(join(output,'incident-report.json'),JSON.stringify(report,null,2));
 // Actual collector backend outage must return a partial report, never throw through business paths.
 stage('testing-outage');await docker(['stop','prometheus','tempo']);
 const outage=await new IncidentAnalysis(defaultCollectors({prometheus,tempo},limits),limits).analyze(input);if(outage.status!=='partial'||outage.coverage.metrics!=='unavailable'||outage.coverage.traces!=='unavailable')throw Error('Outage isolation failed');
 result.checks.push({name:'live-backend-outage',passed:true,status:outage.status});result.passed=true;
}catch(error){
 result.error=error.message;result.cause=error.cause?.code;process.exitCode=1;
 if(context){
  try {const raw=await json(context.tempo+'/api/traces/'+context.input.traceId);const batch=(raw.batches??raw.resourceSpans??[])[0];const group=(batch?.scopeSpans??batch?.instrumentationLibrarySpans??[])[0];const span=group?.spans?.[0];result.tempoShape={root:Object.keys(raw),batch:Object.keys(batch??{}),group:Object.keys(group??{}),span:Object.keys(span??{}),statusCode:span?.status?.code,identifierTypes:[typeof span?.traceId,typeof span?.spanId],timeTypes:[typeof span?.startTimeUnixNano,typeof span?.endTimeUnixNano]};}catch{result.tempoShape='unavailable';}
  try {const raw=await json(context.prometheus+'/api/v1/query?query='+encodeURIComponent('http_server_requests_total'));result.metricShape={status:raw.status,resultType:raw.data?.resultType,series:raw.data?.result?.map(row=>({keys:Object.keys(row.metric??{}),service:row.metric?.service_name}))};}catch{result.metricShape='unavailable';}
 }
 try {
  const id=await docker(['ps','-q','prometheus']);
  if(id){const state=JSON.parse((await execute('docker',['inspect','--format','{{json .State}}',id],{timeout:10000})).stdout);result.prometheusState={running:state.Running,oomKilled:state.OOMKilled,exitCode:state.ExitCode};}
  await writeFile(join(output,'prometheus-startup.log'),await docker(['logs','--no-color','--tail','40','prometheus']));
 }catch{result.backendDiagnostics='unavailable';}
}
finally{await state?.shutdown();await reservation?.release();try{await docker(['down','--volumes','--remove-orphans']);const remaining=(await execute('docker',['ps','-aq','--filter','label=com.docker.compose.project='+project])).stdout.trim();if(remaining)throw Error('Owned containers remain');result.cleanup=true;}catch{result.cleanup=false;process.exitCode=1;}if(result.cleanup)await rm(directory,{recursive:true,force:true});await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({component:'incident-live-proof',passed:result.passed,cleanup:result.cleanup,output}));}
