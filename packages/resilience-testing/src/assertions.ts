import type {Evidence} from './model.js';
// Snapshot producers must explicitly establish completeness and include every side
// effect in the inspected fixture. IDs stay in test memory, outside report labels.
export function noDuplicateEffects(rows:readonly {identity:string;effects:number}[]|undefined,complete:boolean,elapsedMs=0):Evidence|undefined{
 if(!rows||rows.length===0||rows.some(r=>!r.identity||!Number.isSafeInteger(r.effects)||r.effects<0))return undefined;
 const totals=new Map<string,number>();for(const row of rows)totals.set(row.identity,(totals.get(row.identity)??0)+row.effects);
 return {observed:[...totals.values()].reduce((sum,n)=>sum+Math.max(0,n-1),0),limit:0,complete,elapsedMs};
}
export function noOverselling(rows:readonly {total:number;reserved:number;available:number}[]|undefined,complete:boolean,elapsedMs=0):Evidence|undefined{
 if(!rows?.length)return undefined;
 return {observed:rows.filter(r=>![r.total,r.reserved,r.available].every(Number.isSafeInteger)||r.total<0||r.reserved<0||r.available<0||r.available!==r.total-r.reserved).length,limit:0,complete,elapsedMs};
}
export function noLostOutbox(committed:readonly string[]|undefined,persisted:readonly string[]|undefined,complete:boolean,elapsedMs=0):Evidence|undefined{
 if(!committed?.length||!persisted)return undefined;const found=new Set(persisted);
 return {observed:committed.filter(id=>!found.has(id)).length,limit:0,complete,elapsedMs};
}
export function validTransitions(rows:readonly {from:string;to:string}[]|undefined,allowed:(from:string,to:string)=>boolean,complete:boolean,elapsedMs=0):Evidence|undefined{
 if(!rows?.length)return undefined;return {observed:rows.filter(r=>!allowed(r.from,r.to)).length,limit:0,complete,elapsedMs};
}
