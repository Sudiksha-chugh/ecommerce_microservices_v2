import {randomUUID} from 'node:crypto';
import type {RequestHandler} from 'express';
import {enabled,startOperation,extract,SpanKind,withRequestId,correlation} from './context.js';
import {httpMetric} from './metrics.js';
export function httpTelemetry(service:string):RequestHandler{return (req,res,next)=>{
 if(!enabled()){next();return;}
 const inbound=req.headers['x-request-id'];const id=service!=='api-gateway'&&typeof inbound==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(inbound)?inbound:typeof res.locals.requestId==='string'?res.locals.requestId:randomUUID();
 // Existing request-id middleware runs first where present; disabled mode adds no headers.
 res.locals.requestId=id;res.setHeader('X-Request-Id',id);
 const method=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(req.method)?req.method:'OTHER';
 const started=performance.now(),span=startOperation('HTTP '+method,SpanKind.SERVER,{'service.name':service,'http.request.method':method},extract(req.headers));
 const fields=span.run(()=>{let fields={};withRequestId(id,()=>{fields=correlation();});return fields;});
 let ended=false;const finish=()=>{if(ended)return;ended=true;const path=req.route?.path;const route=(typeof path==='string'?path:Array.isArray(path)?path.join('|'):'unmatched').slice(0,128);span.update({'http.route':route,'http.response.status_code':res.statusCode});httpMetric(method,route,res.statusCode,(performance.now()-started)/1000);try{if(process.stdout.writableLength<65536)console.info(JSON.stringify({component:'http-request',...fields,service,method,route,status:res.statusCode,durationMs:performance.now()-started}));}catch{}span.end(res.statusCode>=500||!res.writableFinished?true:undefined);};res.once('finish',finish);res.once('close',finish);
 span.run(()=>withRequestId(id,()=>{Object.assign(res.locals,correlation());next();}));
};}
