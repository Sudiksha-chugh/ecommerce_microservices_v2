import {redactEvidence} from './verification-harness.mjs';
const fields=['requests','concurrency','warmupRequests','warmupMs','elapsedMs','p50Ms','p95Ms','p99Ms','throughput','cpuMsPerRequest','rssBytes','heapUsedBytes','errors','warmupErrors'];
export function sqlBenchmarkResult(stdout,stderr,exitCode,mode){
 const failure=error=>({mode,exitCode,error,diagnostic:redactEvidence(String(stderr).slice(0,4096)).slice(0,4096)});
 let raw;try{raw=JSON.parse(stdout);}catch{return failure('invalid_worker_result');}
 if(raw.mode!==mode||fields.some(key=>typeof raw[key]!=='number'||!Number.isFinite(raw[key])||raw[key]<0)||raw.requests!==2000||raw.concurrency!==5||raw.warmupRequests!==100||raw.elapsedMs<=0||raw.p50Ms>raw.p95Ms||raw.p95Ms>raw.p99Ms)return failure('invalid_worker_result');
 return {mode,...Object.fromEntries(fields.map(key=>[key,raw[key]])),exitCode,...(exitCode!==0?{diagnostic:redactEvidence(String(stderr).slice(0,4096)).slice(0,4096)}:{})};
}
