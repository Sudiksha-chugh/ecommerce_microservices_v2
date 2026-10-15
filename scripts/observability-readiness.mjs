// Bounded named operations retain the failing endpoint without credentials or response bodies.
import {performance} from 'node:perf_hooks';
export async function waitForBackend(name,check,report,{budgetMs=120000,pollMs=250,interrupted=()=>false}={}){
 const start=performance.now();let attempts=0,lastError;
 try{do{if(interrupted())throw new Error('Verification interrupted');attempts++;try{const result=await check();report.checks.push({name,passed:true,attempts,elapsedMs:performance.now()-start});return result;}catch(error){lastError=error;}if(performance.now()-start>=budgetMs)break;await new Promise(r=>setTimeout(r,Math.min(pollMs,Math.max(0,budgetMs-(performance.now()-start)))));}while(performance.now()-start<budgetMs);throw lastError??new Error('Readiness deadline exceeded');}
 catch(error){report.failedOperation={name,attempts,elapsedMs:performance.now()-start,error:error.message,cause:error.cause?.code};throw error;}
}
export function ownedContainerState(rows,project){
 if(!/^commerce-v2-observability-[a-f0-9]{12}$/.test(project))throw new Error('Invalid telemetry project ownership');
 return rows.map(row=>{if(row.Config?.Labels?.['com.docker.compose.project']!==project)throw new Error('Foreign container in telemetry diagnostics');return {id:row.Id,name:row.Name,service:row.Config.Labels['com.docker.compose.service'],status:row.State.Status,running:row.State.Running,oomKilled:row.State.OOMKilled,exitCode:row.State.ExitCode,health:row.State.Health?.Status??'not configured',startedAt:row.State.StartedAt,finishedAt:row.State.FinishedAt,restarts:row.RestartCount,memoryLimitBytes:row.HostConfig.Memory,nanoCpus:row.HostConfig.NanoCpus,publishedPorts:row.NetworkSettings?.Ports??{}};});
}

// Hold all selected loopback ports until immediately before Compose binds explicit ports.
// A competing bind fails startup visibly; it never falls back to a different endpoint.
export async function reservePublishedPorts(names,{createListener}={}){
 const {createServer}=await import('node:net');const listeners=[],ports={};let released=false;
 const release=async()=>{if(released)return;released=true;await Promise.all(listeners.map(server=>new Promise((resolve,reject)=>server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()))));};
 try{for(const name of names){const server=(createListener??createServer)();listeners.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});const address=server.address();if(!address||typeof address==='string'||!Number.isInteger(address.port)||address.port<1)throw new Error('Cannot reserve a fixed published port');ports[name]=String(address.port);}return {ports,release};}catch(error){try{await release();}catch{}throw error;}
}
