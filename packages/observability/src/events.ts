import {context,enabled,inject,extract,requestKey} from './context.js';
// Best-effort in-process outbox correlation. No business SQL/schema/payload dependency.
const contexts=new Map<string,{headers:Record<string,unknown>;expires:number}>();
export function captureEventContext(eventId:string){if(!enabled())return;try{const headers=inject();const id=context.active().getValue(requestKey);if(typeof id==='string')headers['x-request-id']=id;if(contexts.size>=512)contexts.delete(contexts.keys().next().value!);contexts.set(eventId,{headers,expires:Date.now()+300000});}catch{}}
export function withEventContext<T>(eventId:string,action:()=>T):T{const entry=contexts.get(eventId);if(!enabled()||!entry||entry.expires<Date.now()){contexts.delete(eventId);return action();}const parent=extract(entry.headers).setValue(requestKey,entry.headers['x-request-id']);return context.with(parent,action);}
