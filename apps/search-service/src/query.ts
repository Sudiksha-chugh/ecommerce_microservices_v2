import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
const price=z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const querySchema=z.strictObject({q:z.string().trim().max(120).default(''),minPrice:price.optional(),maxPrice:price.optional(),
 createdAfter:z.iso.datetime({offset:true}).optional(),createdBefore:z.iso.datetime({offset:true}).optional(),
 sort:z.enum(['relevance','price_asc','price_desc','newest']).default('relevance'),limit:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().max(2048).optional()})
 .refine(v=>v.minPrice===undefined||v.maxPrice===undefined||v.minPrice<=v.maxPrice,'Invalid price range')
 .refine(v=>!v.createdAfter||!v.createdBefore||Date.parse(v.createdAfter)<=Date.parse(v.createdBefore),'Invalid date range');
export type SearchQuery=z.infer<typeof querySchema>;
const cursorSchema=z.strictObject({expires:z.number().int(),fingerprint:z.string(),after:z.tuple([z.union([z.string(),z.number().finite()]),z.uuid()])});
export class CursorCodec {
 private readonly key:Buffer;
 constructor(secret:string){if(secret.length<32)throw new Error('Invalid cursor key');this.key=createHash('sha256').update(secret).digest();}
 private fingerprint(query:SearchQuery){return createHash('sha256').update(JSON.stringify({...query,cursor:undefined})).digest('hex');}
 encode(query:SearchQuery,after:(string|number)[],now=Date.now()){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);const payload=cursorSchema.parse({expires:now+60_000,fingerprint:this.fingerprint(query),after});const encoded=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encoded]).toString('base64url');}
 decode(query:SearchQuery,now=Date.now()){try{const token=query.cursor;if(!token||!/^[a-zA-Z0-9_-]+$/.test(token))throw new Error();const bytes=Buffer.from(token,'base64url');if(bytes.length<29||bytes.toString('base64url')!==token)throw new Error();const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));const payload=cursorSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString()));if(payload.expires<=now||payload.expires>now+60_000||payload.fingerprint!==this.fingerprint(query))throw new Error();return payload.after;}catch{throw new Error('Invalid or expired search cursor');}}
}
export function searchBody(query:SearchQuery,after?:[string|number,string]){
 const filter:unknown[]=[{term:{deleted:false}}];
 if(query.minPrice!==undefined||query.maxPrice!==undefined)filter.push({range:{priceInPaise:{...(query.minPrice!==undefined?{gte:query.minPrice}:{}),...(query.maxPrice!==undefined?{lte:query.maxPrice}:{})}}});
 if(query.createdAfter||query.createdBefore)filter.push({range:{createdAt:{...(query.createdAfter?{gte:query.createdAfter}:{}),...(query.createdBefore?{lte:query.createdBefore}:{})}}});
 const sort=query.sort==='relevance'?{_score:'desc'}:query.sort==='newest'?{createdAt:'desc'}:{priceInPaise:query.sort==='price_asc'?'asc':'desc'};
 return {size:query.limit!,timeout:'1500ms',track_total_hits:false,query:{bool:{filter,must:query.q?[{multi_match:{query:query.q,fields:['name^4','description'],type:'bool_prefix',fuzziness:'AUTO:4,7',prefix_length:1,max_expansions:20}}]:[{match_all:{}}]}},sort:[sort,{id:'asc'}],...(after?{search_after:after}:{})};
}
