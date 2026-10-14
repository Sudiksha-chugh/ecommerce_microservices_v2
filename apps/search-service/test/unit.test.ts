import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { productProjectionSchema, validateEvent, signProducerEvent, verifyProducerEvent } from '@ecommerce/messaging';
import { internalHeaders, verifyInternalRequest } from '@ecommerce/security';
import { loadSearchEnvironment } from '../src/config.js';
import { querySchema, searchBody, CursorCodec } from '../src/query.js';
import { mappings } from '../src/mappings.js';
import { selectRoutePolicies, parsePolicyOverrides } from '@ecommerce/rate-limiting';
const document={id:randomUUID(),productVersion:1,name:'Wireless headphones',description:'Bluetooth music',priceInPaise:249900,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),deleted:false};
const event={eventId:randomUUID(),eventType:'catalog.product.created',eventVersion:1,occurredAt:new Date().toISOString(),producer:'catalog-service',correlationId:randomUUID(),causationId:null,payload:{productId:document.id,productVersion:1,changeSequence:1,product:document}};
const key='test-scoped-search-key-xxxxxxxxxxxxxxxxx';
describe('product projection contracts',()=>{
 it('accepts a complete projection and preserves integer money',()=>{expect(productProjectionSchema.parse({...document,priceInPaise:Number.MAX_SAFE_INTEGER}).priceInPaise).toBe(Number.MAX_SAFE_INTEGER);expect(validateEvent(event).producer).toBe('catalog-service');});
 it.each([{customerEmail:'private@example.test'},{category:'invented'},{stock:5},{signature:'injected'}])('rejects extra projection fields %o',extra=>expect(()=>productProjectionSchema.parse({...document,...extra})).toThrow());
 it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects product version %s',productVersion=>expect(()=>productProjectionSchema.parse({...document,productVersion})).toThrow());
 it.each([-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid money %s',priceInPaise=>expect(()=>productProjectionSchema.parse({...document,priceInPaise})).toThrow());
 it('rejects mismatched identity/version, unsupported envelopes and deleted-created events',()=>{
  expect(()=>validateEvent({...event,payload:{...event.payload,productId:randomUUID()}})).toThrow();
  expect(()=>validateEvent({...event,eventVersion:2})).toThrow();expect(()=>validateEvent({...event,producer:'orders-service'})).toThrow();
  expect(()=>validateEvent({...event,payload:{...event.payload,product:{...document,deleted:true}}})).toThrow();
 });
 it('verifies only signed Catalog identity and detects payload tampering',()=>{const signed=signProducerEvent(validateEvent(event),key);expect(verifyProducerEvent(signed,key,'catalog-service').eventId).toBe(event.eventId);expect(()=>verifyProducerEvent({...signed,payload:{...event.payload,product:{...document,name:'tampered'}}} as typeof signed,key,'catalog-service')).toThrow();});
 it('accepts bounded Unicode code points without rejecting valid emoji projections',()=>{expect(productProjectionSchema.parse({...document,description:'😀'.repeat(20000)}).description).toHaveLength(40000);});
 it('bounds indexed description without adding absent Catalog attributes',()=>{expect(()=>productProjectionSchema.parse({...document,description:'x'.repeat(20001)})).toThrow();expect(mappings.dynamic).toBe('strict');expect(mappings.properties.priceInPaise.type).toBe('long');expect(Object.keys(mappings.properties)).not.toContain('stock');expect(Object.keys(mappings.properties)).not.toContain('category');});
});
describe('query validation and safe DSL',()=>{
 it.each([{q:'x'.repeat(121)},{minPrice:-1},{maxPrice:'abc'},{minPrice:10,maxPrice:1},{sort:'script'},{limit:101},{limit:0},{category:'absent'},{query:{match_all:{}}},{cursor:'x'.repeat(2049)},{createdAfter:'bad'}])('rejects invalid query %o',input=>expect(querySchema.safeParse(input).success).toBe(false));
 it.each(['relevance','price_asc','price_desc','newest'] as const)('allowlists sort %s with deterministic ID tie breaker',sort=>{const body=searchBody({...querySchema.parse({sort}),limit:20});expect(body.sort[1]).toEqual({id:'asc'});});
 it('uses a bounded query with forced deletion filtering, minor-unit price ranges and date ranges',()=>{
  const body=searchBody({...querySchema.parse({q:'wirless headphone',minPrice:10,maxPrice:100,createdAfter:'2020-01-01T00:00:00Z'}),limit:20});
  expect(body.query.bool.filter).toContainEqual({term:{deleted:false}});expect(body.size).toBe(20);expect(body.track_total_hits).toBe(false);
  expect(JSON.stringify(body)).toContain('max_expansions');expect(JSON.stringify(body)).not.toContain('wildcard');
 });
 it('treats JSON-looking client text as plain multi-match text, never DSL',()=>{const q='{"match_all":{}}';const body=searchBody({...querySchema.parse({q}),limit:20});expect(JSON.stringify(body)).toContain('\\"match_all\\"');});
});
describe('opaque authenticated cursors',()=>{
 const codec=new CursorCodec(key);const query={...querySchema.parse({q:'music',sort:'price_asc'}),limit:2};
 it('round-trips a cursor bound to query and expiration',()=>{const after:[number,string]=[100,randomUUID()];const cursor=codec.encode(query,after,100000);expect(codec.decode({...query,cursor},100001)).toEqual(after);expect(cursor).not.toContain(after[1]);});
 it.each(['tampered','expired','query','limit','malformed'])('rejects %s cursor',kind=>{let cursor=codec.encode(query,[100,randomUUID()],100000);if(kind==='tampered')cursor='A'+cursor.slice(1);if(kind==='malformed')cursor='!';expect(()=>codec.decode({...query,cursor,...(kind==='query'?{q:'changed'}:{}),...(kind==='limit'?{limit:3}:{})},kind==='expired'?160001:100001)).toThrow();});
});
describe('opt-in and service trust boundaries',()=>{
 it('defaults all Search flags off',()=>{const config=loadSearchEnvironment({});expect([config.SEARCH_ENABLED,config.SEARCH_INDEXING_ENABLED,config.SEARCH_REBUILD_ENABLED]).toEqual([false,false,false]);});
 it.each([{SEARCH_ENABLED:'true'},{SEARCH_INDEXING_ENABLED:'true'},{SEARCH_REBUILD_ENABLED:'true'},{SEARCH_MAX_LIMIT:'999'},{SEARCH_INDEX_ALIAS:'products_v1'},{SEARCH_ELASTICSEARCH_URL:'http://user:password@localhost'},{SEARCH_DEFAULT_LIMIT:'30',SEARCH_MAX_LIMIT:'20'}])('rejects invalid/incomplete configuration %o',env=>expect(()=>loadSearchEnvironment(env)).toThrow());
 it('binds internal search identity to the signed path, method, caller and timestamp',()=>{const path='/internal/catalog/search-export?through=10';const headers=internalHeaders('GET',path,key,Date.now(),'search');expect(verifyInternalRequest(headers,'GET',path,key,Date.now(),'search')).toBe(true);expect(verifyInternalRequest(headers,'GET',path+'&after=2',key,Date.now(),'search')).toBe(false);expect(verifyInternalRequest(headers,'POST',path,key,Date.now(),'search')).toBe(false);expect(verifyInternalRequest(headers,'GET',path,key)).toBe(false);expect(verifyInternalRequest(headers,'GET',path,key,Date.now()+31000,'search')).toBe(false);});
 it('composes SEARCH with the existing anonymous/authenticated budget and validated overrides',()=>{expect(selectRoutePolicies('GET','/search/products',false,false).names).toEqual(['GLOBAL_ANONYMOUS','SEARCH']);expect(selectRoutePolicies('GET','/SEARCH/PRODUCTS/',true,false).names).toEqual(['GLOBAL_AUTHENTICATED','SEARCH']);expect(parsePolicyOverrides('{"SEARCH":{"capacity":10,"refillTokens":5,"windowMs":60000}}').SEARCH?.capacity).toBe(10);});
});
