import type { Pool } from 'pg';
import { z } from 'zod';
import type { ProductProjection } from '@ecommerce/messaging';
const sequence = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const exportQuery = z.strictObject({ mode:z.enum(['state','changes']).default('state'), through:sequence,
 after:z.string().max(40).default(''),limit:z.coerce.number().int().min(1).max(100).default(100) })
 .refine(v=>v.mode==='state'?v.after===''||z.uuid().safeParse(v.after).success:/^\d*$/.test(v.after)&&Number.isSafeInteger(Number(v.after))&&Number(v.after)>=0);
export class CatalogSearchSource {
 constructor(private readonly pool:Pool){}
 async documents(ids:string[]){return (await this.pool.query<{document:ProductProjection}>('SELECT document FROM catalog_search_documents WHERE id=ANY($1::uuid[])',[ids])).rows.map(row=>row.document);}
 async watermark(){return Number((await this.pool.query('SELECT sequence FROM catalog_search_clock WHERE singleton')).rows[0].sequence);}
 async export(query:z.infer<typeof exportQuery>){
  if(query.mode==='state')return (await this.pool.query<{document:ProductProjection;cursor:string}>(
   'SELECT document,id::text AS cursor FROM catalog_search_documents WHERE change_sequence<=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3',[query.through,query.after||null,query.limit])).rows;
  return (await this.pool.query<{document:ProductProjection;cursor:string}>(
   'SELECT document,sequence::text AS cursor FROM catalog_search_changes WHERE sequence>$1 AND sequence<=$2 ORDER BY sequence LIMIT $3',[query.after||'0',query.through,query.limit])).rows;
 }
 async visible(ids:string[]){return (await this.pool.query<{id:string}>('SELECT id FROM products WHERE id=ANY($1::uuid[])',[ids])).rows.map(row=>row.id);}
}
