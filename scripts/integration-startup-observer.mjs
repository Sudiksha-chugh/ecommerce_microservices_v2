// Opt-in, bounded read-only startup evidence for one explicitly owned project.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import amqp from 'amqplib';
import {ownedProject,parseStartupRows} from './verification-harness.mjs';
const execute=promisify(execFile);
export function observeStartup(project,emit,{executeCommand=execute,fetchRequest=fetch,connectAmqp=amqp.connect,maxSamples=12,scheduleTimer=true}={}){
 ownedProject(project);
 if(!Number.isInteger(maxSamples)||maxSamples<1||maxSamples>12)throw new Error('Invalid startup observation bound');
 const rabbit=project+'-rabbitmq-1',postgres=project+'-postgres-1';
 let active,closed=false,count=0,previous=performance.now();
 const command=async args=>{const start=performance.now();try{return (await executeCommand('docker',args,{timeout:5000,maxBuffer:24000})).stdout;}finally{emit('startup_docker_read',{command:args[0],durationMs:performance.now()-start});}};
 async function sample(){
  if(count++>=maxSamples)return;
  const now=performance.now();emit('startup_observer_tick',{timerGapMs:now-previous});previous=now;
  try{
   const format='{"Name":{{json .Name}},"Created":{{json .Created}},"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"State":{{json .State}},"RestartCount":{{.RestartCount}},"Memory":{{.HostConfig.Memory}},"NanoCpus":{{.HostConfig.NanoCpus}},"Ports":{{json .NetworkSettings.Ports}}}';
   const {broker,postgres:pg}=parseStartupRows(await command(['inspect','--format',format,postgres,rabbit]),project);
   const state=broker.State;
   emit('rabbit_startup_state',{created:broker.Created,startedAt:state.StartedAt,running:state.Running,paused:state.Paused,oomKilled:state.OOMKilled,restartCount:broker.RestartCount,pid:state.Pid,health:state.Health?.Status,healthChecks:state.Health?.Log?.slice(-3).map(row=>({start:row.Start,end:row.End,exitCode:row.ExitCode})),memoryLimit:broker.Memory,nanoCpus:broker.NanoCpus});
   if(!state.Running)return;
   // Bash builtins read kernel counters without spawning a process per thread.
   const proc=await command(['exec',rabbit,'bash','-c','for p in /proc/loadavg /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io /proc/meminfo /proc/1/stat /proc/1/task/*/schedstat; do while IFS= read -r line; do printf "%s %s\\n" "$p" "$line"; done < "$p"; done']);
   emit('rabbit_startup_kernel',{snapshot:proc.slice(0,16000)});
   const stats=await command(['stats','--no-stream','--format','{{json .}}',postgres,rabbit]);
   emit('startup_container_resources',{rows:stats.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))});
   const binding=target=>pg.Ports?.[target+'/tcp']?.find(row=>row.HostIp==='127.0.0.1')?.HostPort;
   const managementPort=binding(15672),amqpPort=binding(5672);
   if(!managementPort||!amqpPort)return;
   let management='unavailable',amqpReady=false;
   const started=performance.now();
   try{
    const response=await fetchRequest('http://127.0.0.1:'+managementPort+'/api/nodes',{headers:{authorization:'Basic '+Buffer.from('stabilization_admin:isolated_regression_broker_only').toString('base64'),connection:'close'},signal:AbortSignal.timeout(2000)});
    management=response.status;
    if(response.ok){const nodes=await response.json();emit('rabbit_startup_nodes',{nodes:nodes.map(n=>({running:n.running,memAlarm:n.mem_alarm,diskAlarm:n.disk_free_alarm,runQueue:n.run_queue,processes:n.proc_used,processLimit:n.proc_total,memoryUsed:n.mem_used,memoryLimit:n.mem_limit}))});}else await response.body?.cancel();
   }catch{}
   emit('rabbit_startup_management',{status:management,durationMs:performance.now()-started});
   const connected=performance.now();let connection;
   try{connection=await connectAmqp('amqp://stabilization_admin:isolated_regression_broker_only@127.0.0.1:'+amqpPort+'/commerce_test',{timeout:2000});connection.on('error',()=>{});amqpReady=true;}
   catch{}
   finally{if(connection){const timer=setTimeout(()=>connection.connection.stream.destroy(new Error('Startup probe close deadline')),2000);try{await connection.close();}catch{}finally{clearTimeout(timer);}}}
   emit('rabbit_startup_amqp',{ready:amqpReady,durationMs:performance.now()-connected});
  }catch(error){emit('startup_observer_unavailable',{code:typeof error.code==='string'?error.code:error.name});}
 }
 function schedule(){if(closed||active)return;active=sample().finally(()=>{active=undefined;});}
 schedule();const timer=scheduleTimer?setInterval(schedule,15000):undefined;timer?.unref();
 return async()=>{closed=true;clearInterval(timer);await active;await sample();
  try{const log=await command(['logs','--tail','30',rabbit]);emit('rabbit_boot_log',{lines:log.split('\n').filter(line=>/boot|starting|started|completed|listener|management|alarm|error|failed|memory|plugin/i.test(line)).slice(-20)});}catch(error){emit('rabbit_boot_log_unavailable',{code:error.code??error.name});}
 };
}
