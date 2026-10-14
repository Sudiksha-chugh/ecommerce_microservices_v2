import {context,trace,isSpanContextValid,ROOT_CONTEXT,SpanKind,SpanStatusCode,createContextKey,type Attributes,type Context} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
const requestKey=createContextKey('ecommerce.requestId');
const propagator=new W3CTraceContextPropagator();
export function enabled(){return (globalThis as Record<symbol,unknown>)[Symbol.for('ecommerce.observability')]!==undefined&&(globalThis as Record<symbol,{enabled?:boolean}>)[Symbol.for('ecommerce.observability')]?.enabled===true;}
export function correlation(){const span=trace.getSpanContext(context.active());return {...(typeof context.active().getValue(requestKey)==='string'?{requestId:context.active().getValue(requestKey)}:{}),...(span&&isSpanContextValid(span)?{traceId:span.traceId,spanId:span.spanId}:{}),...(enabled()?{service:(globalThis as Record<symbol,{serviceName?:string}>)[Symbol.for('ecommerce.observability')]?.serviceName}:{})};}
export function withRequestId(id:string,action:()=>void){context.with(context.active().setValue(requestKey,id),action);}
export function extract(headers:Record<string,unknown>):Context{
 const carrier:Record<string,string>={};for(const key of ['traceparent','tracestate'])if(typeof headers[key]==='string'&&(headers[key] as string).length<512)carrier[key]=headers[key] as string;
 return propagator.extract(ROOT_CONTEXT,carrier,{keys:Object.keys,get:(c,k)=>c[k]});
}
export function inject(headers:Record<string,unknown>={}){const carrier={...headers};if(enabled())propagator.inject(context.active(),carrier,{set:(c,k,v)=>{c[k]=v;}});return carrier;}
export function messageHeaders(headers:Record<string,unknown>={}){if(!enabled())return headers;const id=correlation().requestId;return {...inject(headers),...(typeof id==='string'&&headers['x-request-id']===undefined?{'x-request-id':id}:{})};}
export function startOperation(name:string,kind:SpanKind,attributes:Attributes,parent=context.active()){
 if(!enabled())return {run:<T>(action:()=>T)=>action(),update:(_attributes:Attributes)=>{},end:(_error?:unknown)=>{}};
 try{const span=trace.getTracer('ecommerce.observability','0.1.0').startSpan(name,{kind,attributes},parent);let finished=false;return {run:<T>(action:()=>T)=>context.with(trace.setSpan(parent,span),action),update:(attributes:Attributes)=>{try{span.setAttributes(attributes);}catch{}},end:(error?:unknown)=>{if(finished)return;finished=true;try{if(error)span.setStatus({code:SpanStatusCode.ERROR,message:'operation_failed'});span.end();}catch{/* No telemetry error replaces a business outcome. */}}};}catch{return {run:<T>(action:()=>T)=>action(),update:(_attributes:Attributes)=>{},end:(_error?:unknown)=>{}};}
}
export async function operation<T>(name:string,attributes:Attributes,action:()=>Promise<T>,kind=SpanKind.INTERNAL,parent=context.active()):Promise<T>{const span=startOperation(name,kind,attributes,parent);try{return await span.run(action);}catch(error){span.end(error);throw error;}finally{span.end();}}
export {SpanKind,context,requestKey};

export function markOperationError(){if(!enabled())return;try{trace.getSpan(context.active())?.setStatus({code:SpanStatusCode.ERROR,message:'operation_failed'});}catch{}}
