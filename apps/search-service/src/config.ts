import { z } from 'zod';
const secret=z.preprocess(v=>v===''?undefined:v,z.string().min(32).optional());
const flag=z.enum(['true','false']).default('false').transform(v=>v==='true');
const origin=z.url().refine(v=>{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash;});
const schema=z.object({
 SEARCH_ENABLED:flag,SEARCH_INDEXING_ENABLED:flag,SEARCH_REBUILD_ENABLED:flag,
 SEARCH_HOST:z.string().default('127.0.0.1'),SEARCH_PORT:z.coerce.number().int().min(1).max(65535).default(4008),
 SEARCH_ELASTICSEARCH_URL:origin.default('http://127.0.0.1:9210'),SEARCH_ELASTICSEARCH_API_KEY:z.string().optional(),
 SEARCH_INDEX_ALIAS:z.string().regex(/^commerce_v2_products_[a-z0-9_]{1,40}$/).default('commerce_v2_products_current'),
 SEARCH_DEFAULT_LIMIT:z.coerce.number().int().min(1).max(100).default(20),SEARCH_MAX_LIMIT:z.coerce.number().int().min(1).max(100).default(100),
 SEARCH_REQUEST_TIMEOUT_MS:z.coerce.number().int().min(20).max(10000).default(2000),
 SEARCH_DATABASE_URL:z.url().default('postgresql://search_user:unconfigured@127.0.0.1:5441/search_db'),
 SEARCH_RABBITMQ_URL:z.string().optional(),SEARCH_RABBITMQ_PREFETCH:z.coerce.number().int().min(1).max(20).default(5),
 SEARCH_CATALOG_URL:origin.default('http://127.0.0.1:4001'),SEARCH_LOOKUP_KEY:secret,CATALOG_EVENT_KEY:secret,
 SEARCH_CURSOR_KEY:secret,JWT_PUBLIC_KEY_FILE:z.string().optional(),JWT_ISSUER:z.string().optional(),JWT_AUDIENCE:z.string().optional(),
 SHUTDOWN_TIMEOUT_MS:z.coerce.number().int().min(100).max(30000).default(10000),
}).superRefine((v,ctx)=>{
 if(v.SEARCH_DEFAULT_LIMIT>v.SEARCH_MAX_LIMIT)ctx.addIssue({code:'custom',message:'Default exceeds max limit'});
 if(v.SEARCH_ENABLED||v.SEARCH_INDEXING_ENABLED||v.SEARCH_REBUILD_ENABLED)for(const key of ['SEARCH_LOOKUP_KEY','JWT_PUBLIC_KEY_FILE','JWT_ISSUER','JWT_AUDIENCE'] as const)if(!v[key])ctx.addIssue({code:'custom',path:[key],message:'Required'});
 if(v.SEARCH_ENABLED&&!v.SEARCH_CURSOR_KEY)ctx.addIssue({code:'custom',path:['SEARCH_CURSOR_KEY'],message:'Required'});
 if(v.SEARCH_INDEXING_ENABLED&&(!v.CATALOG_EVENT_KEY||!v.SEARCH_RABBITMQ_URL))ctx.addIssue({code:'custom',message:'Indexer requires broker and Catalog signature key'});
});
export type SearchConfig=z.infer<typeof schema>;
export function loadSearchEnvironment(env:NodeJS.ProcessEnv=process.env):SearchConfig{const parsed=schema.safeParse(env);if(!parsed.success)throw new Error('Invalid Search configuration');return parsed.data;}
