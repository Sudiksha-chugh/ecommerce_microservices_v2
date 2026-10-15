import { z } from 'zod';
import { internalHeaders } from '@ecommerce/security';
import { productProjectionSchema } from '@ecommerce/messaging';
import { SearchUnavailableError } from './elasticsearch.js';
const rowsSchema=z.object({rows:z.array(z.object({document:productProjectionSchema,cursor:z.string()})).max(100)});
export class CatalogClient {
 constructor(readonly origin:string,private readonly key:string,private readonly timeoutMs=2000){}
 private async get(path:string){try{const response=await fetch(this.origin+path,{headers:internalHeaders('GET',path,this.key,Date.now(),'search'),signal:AbortSignal.timeout(this.timeoutMs)});if(!response.ok)throw new Error();return await response.json() as unknown;}catch{throw new SearchUnavailableError('CATALOG_UNAVAILABLE');}}
 async watermark(){return z.object({watermark:z.number().int().nonnegative()}).parse(await this.get('/internal/catalog/search-watermark')).watermark;}
 async export(mode:'state'|'changes',through:number,after='',limit=100){const path='/internal/catalog/search-export?'+new URLSearchParams({mode,through:String(through),after,limit:String(limit)});return rowsSchema.parse(await this.get(path)).rows;}
 async documents(ids:string[]){if(!ids.length)return [];return z.object({documents:z.array(productProjectionSchema).max(100)}).parse(await this.get('/internal/catalog/search-documents?'+new URLSearchParams({ids:ids.join(',')}))).documents;}
 async visible(ids:string[]){if(!ids.length)return [];return z.object({ids:z.array(z.uuid()).max(100)}).parse(await this.get('/internal/catalog/search-visible?'+new URLSearchParams({ids:ids.join(',')}))).ids;}
}
