// Deliberately conservative structural compatibility for this registry's JSON Schema subset.
// Response/event schemas describe possible provider output. Consumers must accept that set.
export type Schema={type?:string;properties?:Record<string,Schema>;required?:string[];enum?:unknown[];const?:unknown;items?:Schema;additionalProperties?:boolean;[key:string]:unknown};
export interface Contract {id:string;consumer:string;provider:string;version:number;method?:string;path?:string;authorization?:'public'|'bearer'|'admin';status?:number;schema:Schema}
export function compatibility(consumer:Contract,provider:Contract):string[]{
 const failures:string[]=[];
 for(const key of ['id','provider','version','method','path','authorization','status'] as const)if(consumer[key]!==provider[key])failures.push(`metadata.${key}`);
 function compare(expected:Schema,actual:Schema,path:string){
  if(expected.type!==actual.type)failures.push(`${path}.type`);
  if(expected.const!==undefined&&expected.const!==actual.const)failures.push(`${path}.const`);
  if(expected.enum){const values=actual.enum??(actual.const!==undefined?[actual.const]:undefined);if(!values||values.some(v=>!expected.enum!.includes(v)))failures.push(`${path}.enum`);}
  if(expected.properties){
   for(const key of expected.required??[])if(!actual.required?.includes(key)||!actual.properties?.[key])failures.push(`${path}.${key}.required`);
   for(const [key,schema] of Object.entries(expected.properties)){const candidate=actual.properties?.[key];if(candidate)compare(schema,candidate,`${path}.${key}`);}
   if(expected.additionalProperties===false&&(actual.additionalProperties!==false||Object.keys(actual.properties??{}).some(k=>!Object.hasOwn(expected.properties!,k))))failures.push(`${path}.unknown-fields`);
  }
  if(expected.items){if(!actual.items)failures.push(`${path}.items`);else compare(expected.items,actual.items,`${path}[]`);}
  // Unsupported validation keywords require exact equality: no optimistic compatibility claims.
  for(const key of Object.keys(expected).filter(k=>!['type','properties','required','enum','const','items','additionalProperties','$schema'].includes(k)))if(JSON.stringify(expected[key])!==JSON.stringify(actual[key]))failures.push(`${path}.${key}`);
 }
 compare(consumer.schema,provider.schema,'schema');return failures.slice(0,100);
}
