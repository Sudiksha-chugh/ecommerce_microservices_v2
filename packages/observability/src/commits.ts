import {enabled} from './context.js';
import {observeBusiness,type BusinessOperation} from './metrics.js';
// Only transaction owners may flush. Weak keys and a cap avoid retaining clients/work indefinitely.
const pending=new WeakMap<object,Array<()=>void>>();
export function afterCommit(client:object,operation:BusinessOperation,outcome:'success'|'error'|'observed'='observed'){
 if(!enabled())return;const callbacks=pending.get(client)??[];if(callbacks.length<128)callbacks.push(()=>observeBusiness(operation,outcome));pending.set(client,callbacks);
}
export function committed(client:object){const callbacks=pending.get(client);pending.delete(client);for(const callback of callbacks??[])try{callback();}catch{}}
export function rolledBack(client:object){pending.delete(client);}
