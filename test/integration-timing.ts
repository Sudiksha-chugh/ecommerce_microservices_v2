// Opt-in diagnostics supplied only by the disposable runner. No request data.
import {appendFileSync} from 'node:fs';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {afterAll,beforeEach,afterEach} from 'vitest';
if(process.env.INTEGRATION_ENV_DIR&&process.versions.node.split('.')[0]!=='24')throw new Error('Isolated test workers require Node.js 24');
const file=process.env.INTEGRATION_DIAGNOSTICS_FILE;
if(file){
 const delay=monitorEventLoopDelay({resolution:20});delay.enable();let rows=0,last=performance.now(),cpu=process.cpuUsage(),util=performance.eventLoopUtilization(),started=0,writeCount=0,writeTotalMs=0,writeMaxMs=0;
 const emit=(operation:string,values:Record<string,unknown>)=>{if(rows++<1000){const line=JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),pid:process.pid,operation,...values})+'\n';const start=performance.now();appendFileSync(file,line);const elapsed=performance.now()-start;writeCount++;writeTotalMs+=elapsed;writeMaxMs=Math.max(writeMaxMs,elapsed);}};
 emit('worker_runtime',{runtime:process.version,isolated:!!process.env.INTEGRATION_ENV_DIR});
 const sample=()=>{const now=performance.now(),nextCpu=process.cpuUsage(),nextUtil=performance.eventLoopUtilization();emit('worker_sample',{timerGapMs:now-last,eventLoopDelayMaxMs:delay.max/1e6,eventLoopUtilization:performance.eventLoopUtilization(nextUtil,util).utilization,cpuUserMs:(nextCpu.user-cpu.user)/1000,cpuSystemMs:(nextCpu.system-cpu.system)/1000,diagnosticWrites:{count:writeCount,totalMs:writeTotalMs,maxMs:writeMaxMs},rssBytes:process.memoryUsage().rss});last=now;cpu=nextCpu;util=nextUtil;delay.reset();};
 const timer=setInterval(sample,10000);timer.unref();if(process.env.INTEGRATION_DIAGNOSTICS_MODE!=='minimal'){beforeEach(()=>{started=performance.now();});afterEach(ctx=>{emit('test_and_hooks',{durationMs:performance.now()-started,status:ctx.task.result?.state});});}afterAll(()=>{sample();clearInterval(timer);delay.disable();});
}
