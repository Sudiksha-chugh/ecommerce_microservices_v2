import {createHash} from 'node:crypto';
import {metrics} from '@opentelemetry/api';
import {enabled} from './context.js';

export interface SqlTelemetryConfig {enabled:boolean;sampleRatio:number;maxFingerprints:number;retentionMs:number;slowMs:number}
const operations=new Set(['SELECT','INSERT','UPDATE','DELETE','BEGIN','COMMIT','ROLLBACK','WITH','CREATE','ALTER','DROP']);
const safeOperation=(value:string)=>operations.has(value)?value:'OTHER';
const defaults:SqlTelemetryConfig={enabled:false,sampleRatio:0.1,maxFingerprints:32,retentionMs:300000,slowMs:250};
export function sqlTelemetryConfig(env:NodeJS.ProcessEnv=process.env):SqlTelemetryConfig {
 if(env.OTEL_SQL_ENABLED!=='true')return {...defaults};
 const number=(key:string,fallback:number,min:number,max:number,integer=false)=>{const n=Number(env[key]??fallback);if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw new Error('Invalid SQL telemetry configuration');return n;};
 try{return {enabled:true,sampleRatio:number('OTEL_SQL_SAMPLE_RATIO',0.1,0,1),maxFingerprints:number('OTEL_SQL_MAX_FINGERPRINTS',32,1,32,true),retentionMs:number('OTEL_SQL_RETENTION_MS',300000,1000,3600000,true),slowMs:number('OTEL_SQL_SLOW_MS',250,1,10000,true)};}catch{return {...defaults};}
}
// Lexical reduction is used only to construct a digest; never expose or retain its input.
// Unsupported syntax, malformed literals, and oversized statements are not fingerprinted.
export function sqlFingerprint(input:unknown):string|undefined {
 if(typeof input!=='string'||input.length>8192||!input.length)return;
 const tokens:string[]=[];let i=0;
 while(i<input.length){const tail=input.slice(i),c=input[i]!;
  if(/\s/.test(c)){i++;continue;}
  if(tail.startsWith('--')){const end=input.indexOf('\n',i+2);i=end<0?input.length:end+1;continue;}
  if(tail.startsWith('/*')){let depth=1;i+=2;while(i<input.length&&depth){if(input.startsWith('/*',i)){depth++;i+=2;}else if(input.startsWith('*/',i)){depth--;i+=2;}else i++;}if(depth)return;continue;}
  const dollar=tail.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
  if(dollar){const end=input.indexOf(dollar,i+dollar.length);if(end<0)return;i=end+dollar.length;tokens.push('?');continue;}
  const prefix=tail.match(/^(?:[eEbBxXnN]|[uU]&)?'/)?.[0];
  if(prefix){i+=prefix.length;let closed=false;while(i<input.length){if(input[i]==='\\'){i+=2;continue;}if(input[i]==="'"){if(input[i+1]==="'"){i+=2;continue;}i++;closed=true;break;}i++;}if(!closed)return;tokens.push('?');continue;}
  if(c==='"'||/^[uU]&"/.test(tail)){i+=c==='"'?1:3;let closed=false;while(i<input.length){if(input[i]==='"'){if(input[i+1]==='"'){i+=2;continue;}i++;closed=true;break;}i++;}if(!closed)return;tokens.push('identifier');continue;}
  const parameter=tail.match(/^\$[0-9]+/);if(parameter){i+=parameter[0].length;tokens.push('?');continue;}
  const numeric=tail.match(/^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]+)?)/);
  if(numeric){i+=numeric[0].length;tokens.push('?');continue;}
  const word=tail.match(/^[a-zA-Z_][a-zA-Z_0-9$]*/);if(word){i+=word[0].length;tokens.push(['true','false','null'].includes(word[0].toLowerCase())?'?':word[0].toLowerCase());continue;}
  if('(),.;:+-*/%=<>!~^|&[]'.includes(c)){tokens.push(c);i++;continue;}
  return;
 }
 return tokens.length?'q_'+createHash('sha256').update(tokens.join(' ')).digest('hex').slice(0,24):undefined;
}
export const sqlBucketsMs=[1,5,10,25,50,100,250,500,1000,2500,5000,10000] as const;
interface Entry {fingerprint:string;operation:string;sampledCount:number;errors:number;slow:number;totalMs:number;maxMs:number;histogram:number[];lastSeen:number}
export class SqlTelemetryStore {
 private entries=new Map<string,Entry>();private observed=0;private sampled=0;private dropped=0;
 readonly config:Readonly<SqlTelemetryConfig>;
 constructor(config:SqlTelemetryConfig,private now=()=>performance.now(),private random=Math.random){
  if(typeof config.enabled!=='boolean'||!Number.isFinite(config.sampleRatio)||config.sampleRatio<0||config.sampleRatio>1||!Number.isInteger(config.maxFingerprints)||config.maxFingerprints<1||config.maxFingerprints>32||!Number.isInteger(config.retentionMs)||config.retentionMs<1000||config.retentionMs>3600000||!Number.isFinite(config.slowMs)||config.slowMs<1||config.slowMs>10000)throw new Error('Invalid SQL storage bounds');
  this.config=Object.freeze({...config});
 }
 private expire(){const cutoff=this.now()-this.config.retentionMs;for(const [key,value] of this.entries)if(value.lastSeen<=cutoff)this.entries.delete(key);}
 begin(sql:unknown,operation:string){
  if(!this.config.enabled)return;
  operation=safeOperation(operation);this.expire();this.observed++;
  if(this.random()>=this.config.sampleRatio)return;
  const fingerprint=sqlFingerprint(sql);if(!fingerprint){this.dropped++;return;}
  this.sampled++;
  if(!this.entries.has(fingerprint)&&this.entries.size>=this.config.maxFingerprints){this.dropped++;return;}
  let done=false;
  return {fingerprint,finish:(ms:number,error:boolean)=>{if(done)return;done=true;if(!Number.isFinite(ms)||ms<0)return;this.expire();let entry=this.entries.get(fingerprint);if(!entry){if(this.entries.size>=this.config.maxFingerprints){this.dropped++;return;}entry={fingerprint,operation,sampledCount:0,errors:0,slow:0,totalMs:0,maxMs:0,histogram:Array(sqlBucketsMs.length+1).fill(0),lastSeen:this.now()};this.entries.set(fingerprint,entry);}entry.sampledCount++;entry.errors+=Number(error);entry.slow+=Number(ms>=this.config.slowMs);entry.totalMs+=ms;entry.maxMs=Math.max(entry.maxMs,ms);entry.lastSeen=this.now();const bucket=sqlBucketsMs.findIndex(bound=>ms<=bound);entry.histogram[bucket<0?sqlBucketsMs.length:bucket]!++;}};
 }
 snapshot(){this.expire();return {enabled:this.config.enabled,sampleRatio:this.config.sampleRatio,retentionMs:this.config.retentionMs,maxFingerprints:this.config.maxFingerprints,observed:this.observed,sampled:this.sampled,dropped:this.dropped,bucketUpperBoundsMs:[...sqlBucketsMs,'+Inf'],queries:[...this.entries.values()].map(e=>({...e,histogram:[...e.histogram]})).sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint))};}
}
let store:SqlTelemetryStore|undefined;
export function sqlTelemetrySnapshot(){const snapshot=(store??=new SqlTelemetryStore(sqlTelemetryConfig())).snapshot();return {...snapshot,enabled:enabled()&&snapshot.enabled};}
let instruments:ReturnType<typeof createInstruments>|undefined;
function createInstruments(){const meter=metrics.getMeter('ecommerce.sql','0.1.0');return {count:meter.createCounter('sql.query.executions'),errors:meter.createCounter('sql.query.errors'),slow:meter.createCounter('sql.query.slow'),duration:meter.createHistogram('sql.query.duration',{unit:'s',advice:{explicitBucketBoundaries:sqlBucketsMs.map(n=>n/1000)}})};}
export function beginSqlObservation(sql:unknown,operation:string){
 if(!enabled())return;
 operation=safeOperation(operation);
 try{const current=store??=new SqlTelemetryStore(sqlTelemetryConfig());if(!current.config.enabled)return;const sample=current.begin(sql,operation);let done=false;return {fingerprint:sample?.fingerprint,finish:(ms:number,error:boolean)=>{if(done)return;done=true;try{sample?.finish(ms,error);const m=instruments??=createInstruments(),labels={operation};m.count.add(1,labels);m.duration.record(ms/1000,labels);m.errors.add(error?1:0,labels);m.slow.add(ms>=current.config.slowMs?1:0,labels);}catch{}}};}catch{return;}
}
