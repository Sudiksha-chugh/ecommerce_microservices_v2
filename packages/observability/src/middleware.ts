import {randomUUID} from 'node:crypto';
import type {Request,RequestHandler} from 'express';
import {match} from 'path-to-regexp';
import {enabled,startOperation,extract,SpanKind,withRequestId,correlation} from './context.js';
import {httpMetric} from './metrics.js';
// Express stores the whole registration array in req.route.path. Resolve its matched
// registered template with the same matcher; never use a concrete URL as a label.
const routeMatchers=new WeakMap<object,{sensitive:boolean;strict:boolean;entries:{template:string;matches:ReturnType<typeof match>}[]}>();
function routeTemplate(req:Request):string{
 try{const path=req.route?.path;if(typeof path==='string')return path;if(!Array.isArray(path))return 'unmatched';
  const sensitive=req.app.enabled('case sensitive routing'),strict=req.app.enabled('strict routing');let cached=routeMatchers.get(req.route);
  if(!cached||cached.sensitive!==sensitive||cached.strict!==strict){const templates=path.filter((template:unknown):template is string=>typeof template==='string');cached={sensitive,strict,entries:templates.map(template=>({template,matches:match(strict?template:template.replace(/\/+$/,'')||'/',{sensitive,end:true,trailing:!strict,decode:false})}))};routeMatchers.set(req.route,cached);}
  return cached.entries.find(entry=>entry.matches(req.path))?.template??'unmatched';
 }catch{return 'unmatched';}
}
export function httpTelemetry(service:string):RequestHandler{return (req,res,next)=>{
 if(!enabled()){next();return;}
 const inbound=req.headers['x-request-id'];const id=service!=='api-gateway'&&typeof inbound==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(inbound)?inbound:typeof res.locals.requestId==='string'?res.locals.requestId:randomUUID();
 // Existing request-id middleware runs first where present; disabled mode adds no headers.
 res.locals.requestId=id;res.setHeader('X-Request-Id',id);
 const method=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(req.method)?req.method:'OTHER';
 const started=performance.now(),span=startOperation('HTTP '+method,SpanKind.SERVER,{'service.name':service,'http.request.method':method},extract(req.headers));
 const fields=span.run(()=>{let fields={};withRequestId(id,()=>{fields=correlation();});return fields;});
 let ended=false;const finish=()=>{if(ended)return;ended=true;const route=routeTemplate(req).slice(0,128);span.update({'http.route':route,'http.response.status_code':res.statusCode});httpMetric(method,route,res.statusCode,(performance.now()-started)/1000);try{if(process.stdout.writableLength<65536)console.info(JSON.stringify({component:'http-request',...fields,service,method,route,status:res.statusCode,durationMs:performance.now()-started}));}catch{}span.end(res.statusCode>=500||!res.writableFinished?true:undefined);};res.once('finish',finish);res.once('close',finish);
 span.run(()=>withRequestId(id,()=>{Object.assign(res.locals,correlation());next();}));
};}
