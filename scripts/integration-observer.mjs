// Bounded, sanitized runner diagnostics; no URLs, SQL text or credentials.
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {appendFileSync} from 'node:fs';
export function observe(file){
 const delay=monitorEventLoopDelay({resolution:20});delay.enable();let count=0,previous=performance.now(),cpu=process.cpuUsage(),util=performance.eventLoopUtilization();
 const emit=(operation,values={})=>{const row={at:new Date().toISOString(),monotonicMs:performance.now(),pid:process.pid,operation,...values};if(file&&count++<2000)appendFileSync(file,JSON.stringify(row)+'\n');};
 const timer=setInterval(()=>{const now=performance.now(),nextCpu=process.cpuUsage(),nextUtil=performance.eventLoopUtilization();emit('host_sample',{timerGapMs:now-previous,eventLoopDelayMaxMs:delay.max/1e6,eventLoopUtilization:performance.eventLoopUtilization(nextUtil,util).utilization,cpuUserMs:(nextCpu.user-cpu.user)/1000,cpuSystemMs:(nextCpu.system-cpu.system)/1000,rssBytes:process.memoryUsage().rss});previous=now;cpu=nextCpu;util=nextUtil;delay.reset();},5000);timer.unref();
 return {emit,measure:async(name,fn)=>{const start=performance.now();try{const value=await fn();emit(name,{durationMs:performance.now()-start,outcome:'ok'});return value;}catch(error){emit(name,{durationMs:performance.now()-start,outcome:'failed',code:error?.cause?.code??error?.code??error?.name??'ERROR'});throw error;}},close:()=>{clearInterval(timer);delay.disable();}};
}
