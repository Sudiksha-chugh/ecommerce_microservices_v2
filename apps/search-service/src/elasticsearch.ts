import { productProjectionSchema, type ProductProjection } from '@ecommerce/messaging';
import { mappings } from './mappings.js';
export class SearchUnavailableError extends Error {constructor(readonly code='ELASTICSEARCH_UNAVAILABLE'){super('Search temporarily unavailable');}}
export class IndexMissingError extends SearchUnavailableError {}
export class InvalidProjectionError extends Error {}
export class Elasticsearch {
 constructor(readonly origin:string,readonly alias:string,readonly timeoutMs=2000,private readonly apiKey?:string){}
 async request<T=Record<string,unknown>>(method:string,path:string,body?:unknown,accepted:number[]=[]):Promise<T>{
  try{
   const response=await fetch(this.origin+path,{method,signal:AbortSignal.timeout(this.timeoutMs),headers:{'Content-Type':'application/json',...(this.apiKey?{Authorization:`ApiKey ${this.apiKey}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   const text=await response.text();
   if(!response.ok&&!accepted.includes(response.status)){
    const detail=(()=>{try{return JSON.parse(text) as {error?:{type?:string;reason?:string}};}catch{return {};}})();
    if(path.includes('/_doc/')&&(response.status===404||response.status===400&&detail.error?.reason?.includes('require_alias')))throw new IndexMissingError();
    if([400,422].includes(response.status)&&path.includes('/_doc/')&&['mapper_parsing_exception','document_parsing_exception','strict_dynamic_mapping_exception'].includes(detail.error?.type??''))throw new InvalidProjectionError();
    throw new SearchUnavailableError(`ELASTICSEARCH_HTTP_${response.status}`);
   }
   return (text?JSON.parse(text):{}) as T;
  }catch(error){if(error instanceof InvalidProjectionError||error instanceof SearchUnavailableError)throw error;throw new SearchUnavailableError(error instanceof Error&&error.name==='TimeoutError'?'ELASTICSEARCH_TIMEOUT':'ELASTICSEARCH_UNAVAILABLE');}
 }
 async ready(){try{await this.request('GET','/');return true;}catch{return false;}}
 async create(index:string){await this.request('PUT',`/${index}`,{settings:{number_of_shards:1,number_of_replicas:0},mappings,aliases:{[`${index}_write`]:{is_write_index:true}}},[400]);
  // A duplicate create is safe only when the exact owned index is present with strict mappings.
  const state=await this.request<Record<string,{mappings:typeof mappings}>>('GET',`/${index}/_mapping`);
  if(state[index]?.mappings.dynamic!=='strict')throw new SearchUnavailableError();
 }
 async put(index:string,document:ProductProjection){const parsed=productProjectionSchema.parse(document);
  await this.request('PUT',`/${index}_write/_doc/${parsed.id}?version_type=external&version=${parsed.productVersion}&require_alias=true`,parsed,[409]);
 }
 async get(index:string,id:string){const result=await this.request<{found?:boolean;_source?:ProductProjection}>('GET',`/${index}/_doc/${id}` ,undefined,[404]);return result.found?productProjectionSchema.parse(result._source):undefined;}
 async current(){const result=await this.request<Record<string,unknown>>('GET',`/_alias/${this.alias}`,undefined,[404]);return Object.keys(result).filter(key=>key!=='error'&&key!=='status');}
 async swap(index:string){const current=await this.current();await this.request('POST','/_aliases',{actions:[...current.map(old=>({remove:{index:old,alias:this.alias,must_exist:true}})),{add:{index,alias:this.alias}}]});const switched=await this.current();if(switched.length!==1||switched[0]!==index)throw new SearchUnavailableError();}
 async refresh(index:string){const result=await this.request<{_shards:{failed:number}}>('POST',`/${index}/_refresh`);if(result._shards.failed)throw new SearchUnavailableError();}
 async scan(index:string,after?:string,limit=100){return this.request<{hits:{hits:{_source:ProductProjection;sort:[string]}[]}}>('POST',`/${index}/_search`,{size:limit,query:{match_all:{}},sort:[{id:'asc'}],...(after?{search_after:[after]}:{})});}
 async search(body:unknown){return this.request<{timed_out:boolean;hits:{hits:{_source:ProductProjection;sort:(string|number)[]}[]}}>('POST',`/${this.alias}/_search?allow_partial_search_results=false`,body);}
}
