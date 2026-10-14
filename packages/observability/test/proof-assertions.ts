import assert from 'node:assert/strict';
type RecordValue=Record<string,unknown>;
export function traceSpans(document:unknown){
 const result:{name:string;id:string;parent:string;traceId:string;service:unknown;attributes:RecordValue}[]=[];
 const id=(value:unknown)=>typeof value!=='string'?'':/^[a-f0-9]+$/i.test(value)&&[16,32].includes(value.length)?value.toLowerCase():Buffer.from(value,'base64').toString('hex');
 const attributes=(rows:unknown)=>Object.fromEntries((Array.isArray(rows)?rows:[]).map(row=>[row.key,Object.values(row.value??{})[0]]));
 function walk(value:unknown,service:unknown){if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const row of value)walk(row,service);return;}const row=value as RecordValue;if(row.resource&&typeof row.resource==='object')service=attributes((row.resource as RecordValue).attributes)['service.name']??service;
  if(typeof row.name==='string'&&typeof row.spanId==='string'){result.push({name:row.name,id:id(row.spanId),parent:id(row.parentSpanId),traceId:id(row.traceId),service,attributes:attributes(row.attributes)});return;}
  for(const nested of Object.values(row))walk(nested,service);
 }walk(document,undefined);return result;
}
export function checkoutParentage(document:unknown,traceId:string){
 const spans=traceSpans(document);assert.ok(spans.length>0,'Tempo response contains no spans');assert.ok(spans.every(s=>s.traceId===traceId),'Trace IDs differ');assert.ok(spans.every(s=>s.service==='observability-proof'),'Unexpected proof service resource');
 const gateway=spans.find(s=>s.name==='HTTP POST'&&s.attributes['service.name']==='api-gateway'&&s.attributes['http.route']==='/checkout');assert.ok(gateway,'Gateway checkout server span missing');
 const client=spans.find(s=>s.name==='http POST'&&s.parent===gateway.id);assert.ok(client,'Gateway client parentage missing');
 const orders=spans.find(s=>s.name==='HTTP POST'&&s.attributes['service.name']==='orders-service'&&s.parent===client.id);assert.ok(orders,'Orders HTTP parentage missing');
 const consumer=spans.find(s=>s.name==='rabbitmq process'&&spans.some(p=>p.name==='rabbitmq publish'&&p.id===s.parent));assert.ok(consumer,'Rabbit producer/consumer parentage missing');
 assert.ok(spans.some(s=>s.name.startsWith('postgresql')&&s.parent),'PostgreSQL child span missing');
 // Only sanitized topology is retained in evidence, never request attributes.
 return spans.map(({name,id,parent,service})=>({name,spanId:id,parentSpanId:parent,service}));
}
export async function cleanupProof(actions:(()=>Promise<unknown>)[]){
 const failures:unknown[]=[];for(const action of actions)try{await action();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'Owned proof cleanup failed');
}
