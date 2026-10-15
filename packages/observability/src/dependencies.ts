import {beginSqlObservation} from './sql-telemetry.js';
import {enabled,startOperation,SpanKind,inject,correlation,context} from './context.js';
import {dependencyMetric,httpClientMetric} from './metrics.js';
export async function telemetryFetch(input:string|URL,init:RequestInit={},dependency:'http'|'elasticsearch'='http'):Promise<Response>{
 if(!enabled())return fetch(input,init);
 const headers=new Headers(init.headers);
 const id=correlation().requestId;if(typeof id==='string'&&!headers.has('x-request-id'))headers.set('x-request-id',id);
 const method=(init.method??'GET').toUpperCase();const safeMethod=['GET','POST','PUT','DELETE','PATCH','HEAD'].includes(method)?method:'OTHER';
 const span=startOperation(dependency+' '+safeMethod,SpanKind.CLIENT,{'dependency':dependency,'http.request.method':safeMethod});const start=performance.now();let failed=false;
 try{const response=await span.run(()=>{const carrier=inject();for(const [k,v] of Object.entries(carrier))if(typeof v==='string')headers.set(k,v);return fetch(input,{...init,headers});});failed=response.status>=400;span.update({'http.response.status_code':response.status});return response;}catch(error){failed=true;throw error;}finally{span.end(failed?true:undefined);if(dependency==='http')httpClientMetric(safeMethod,failed?'error':'success',(performance.now()-start)/1000);else dependencyMetric(dependency,safeMethod,failed?'error':'success',(performance.now()-start)/1000);}
}
const wrapped=new WeakMap<object,object>();
function category(value:unknown,allowed:readonly string[]){const token=typeof value==='string'?value.trim().split(/\s+/)[0]?.toUpperCase():undefined;return token&&allowed.includes(token)?token:'OTHER';}
// Callback and Promise APIs retain their original return shape and callback argument order.
function instrumentCall(target:object,fn:Function,args:unknown[],system:string,op:string,wrapResult?:(value:unknown)=>unknown,sql?:unknown){
 const parent=context.active();
 const observation=system==='postgresql'&&op!=='CONNECT'?beginSqlObservation(sql,op):undefined;
 const span=startOperation(system+' '+op,SpanKind.CLIENT,{'db.system.name':system,'db.operation.name':op}),start=performance.now();let done=false;if(observation?.fingerprint)span.update({'db.query.fingerprint':observation.fingerprint});
 const finish=(error?:unknown,failed=Boolean(error))=>{if(done)return;done=true;observation?.finish(performance.now()-start,failed);span.end(failed?true:undefined);dependencyMetric(system,op,failed?'error':'success',(performance.now()-start)/1000);};
 const callback=args.at(-1);
 if(typeof callback==='function')args=args.slice(0,-1).concat((...values:unknown[])=>{finish(values[0]);if(!values[0]&&wrapResult&&values[1])values[1]=wrapResult(values[1]);return context.with(parent,()=>callback(...values));});
 try{const value=span.run(()=>Reflect.apply(fn,target,args));
  if(value&&typeof value.then==='function')return value.then((result:unknown)=>{finish();return wrapResult?wrapResult(result):result;},(error:unknown)=>{finish(error,true);throw error;});
  if(typeof callback!=='function')finish();return wrapResult&&value?wrapResult(value):value;
 }catch(error){finish(error,true);throw error;}
}
export function instrumentPg<T extends object>(client:T):T{
 if(!enabled())return client;const previous=wrapped.get(client);if(previous)return previous as T;
 const proxy=new Proxy(client,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  if(key==='query')return (...args:unknown[])=>{const sql=typeof args[0]==='object'&&args[0]!==null?Reflect.get(args[0],'text'):args[0];return instrumentCall(target,value,args,'postgresql',category(sql,['SELECT','INSERT','UPDATE','DELETE','BEGIN','COMMIT','ROLLBACK','WITH','CREATE','ALTER','DROP']),undefined,sql);};
  if(key==='connect')return (...args:unknown[])=>instrumentCall(target,value,args,'postgresql','CONNECT',value=>typeof value==='object'&&value!==null?instrumentPg(value):value);
  return value.bind(target);
 }});wrapped.set(client,proxy);return proxy;
}
const redisCommands=['GET','SET','DEL','MGET','MSET','HGET','HGETALL','HSET','HDEL','EXPIRE','PEXPIRE','EVAL','EVALSHA','PING','WATCH','UNWATCH','SADD','SREM','SMEMBERS','EXEC','INCR','DECR'];
export function instrumentRedis<T extends object>(client:T,multi=false):T{
 if(!enabled())return client;const previous=wrapped.get(client);if(previous)return previous as T;
 const proxy=new Proxy(client,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  if(key==='withCommandOptions')return (...args:unknown[])=>instrumentRedis(Reflect.apply(value,target,args),multi);
  if(key==='multi')return (...args:unknown[])=>instrumentRedis(Reflect.apply(value,target,args),true);
  const op=key==='sendCommand'?undefined:typeof key==='string'?key.toUpperCase():'';
  if((!multi&&op&&redisCommands.includes(op))||(multi&&op==='EXEC')||key==='sendCommand')return (...args:unknown[])=>instrumentCall(target,value,args,'redis',op??category(Array.isArray(args[0])?args[0][0]:undefined,redisCommands));
  return (...args:unknown[])=>{const result=Reflect.apply(value,target,args);return result===target?proxy:result;};
 }});wrapped.set(client,proxy);return proxy;
}

export async function dependencyOperation<T>(system:'elasticsearch',operation:string,action:()=>Promise<T>):Promise<T>{
 if(!enabled())return action();const op=category(operation,['GET','POST','PUT','DELETE','HEAD']);const span=startOperation(system+' '+op,SpanKind.CLIENT,{'db.system.name':system,'db.operation.name':op});const start=performance.now();let failed=false;
 try{return await span.run(action);}catch(error){failed=true;throw error;}finally{span.end(failed?true:undefined);dependencyMetric(system,op,failed?'error':'success',(performance.now()-start)/1000);}
}
