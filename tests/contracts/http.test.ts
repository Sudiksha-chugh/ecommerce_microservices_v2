import {describe,it,expect} from 'vitest';
import request from 'supertest';
import {z} from 'zod';
import {createApp as catalogApp} from '../../apps/catalog-service/src/app.js';
import {createApp as authApp} from '../../apps/auth-service/src/app.js';
import {createApp as cartApp} from '../../apps/cart-service/src/app.js';
import {createApp as ordersApp} from '../../apps/orders-service/src/app.js';
import {createApp as inventoryApp} from '../../apps/inventory-service/src/app.js';
import {createApp as searchApp,type AppOptions} from '../../apps/search-service/src/app.js';
import {createApp as paymentsApp} from '../../apps/payments-service/src/app.js';
import {InvalidTokenError,type TokenVerifier} from '@ecommerce/security';
import type {AuthService} from '../../apps/auth-service/src/auth-service.js';
import type {CartService} from '../../apps/cart-service/src/cart-service.js';
import type {OrderService} from '../../apps/orders-service/src/order-service.js';
import type {InventoryService} from '../../apps/inventory-service/src/inventory-service.js';
import type {PaymentService} from '../../apps/payments-service/src/payment-service.js';
import {compatibility,type Contract} from '../../packages/resilience-testing/src/index.js';
const id='00000000-0000-4000-8000-000000000001';
const product={id,name:'Example',description:'Fixture',priceInPaise:100};
const user={id,email:'consumer@example.test',role:'customer' as const};
const order={id,userId:id,status:'PENDING',totalAmountInPaise:100,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',items:[]};
const verify:TokenVerifier=async authorization=>{if(!authorization)throw new InvalidTokenError();return {...user,role:authorization==='Bearer admin'?'admin':'customer'};};
const error=z.object({error:z.object({message:z.string()})});
// Provider HTTP routing/serialization/authentication is real; business dependencies are stubs.
// Persistence and dependency-failure correctness are verified separately with isolated stores.
const search=searchApp({enabled:true,rebuildEnabled:false,defaultLimit:10,maxLimit:100,cursorKey:'c'.repeat(32),verify,elastic:{search:async()=>({timed_out:false,hits:{hits:[]}})},catalog:{visible:async()=>[]},repository:{}} as unknown as AppOptions);
const applications={
 catalog:catalogApp({findAll:async()=>[product],findById:async()=>product,create:async()=>product,update:async()=>product,delete:async()=>true},verify),
 auth:authApp({currentUser:async(a:string|undefined)=>{await verify(a);return user;}} as AuthService),
 cart:cartApp({find:async()=>({items:[]})} as unknown as CartService,verify),
 orders:ordersApp({findById:async()=>order} as unknown as OrderService,verify),
 inventory:inventoryApp({find:async()=>({productId:id,totalStock:1,reservedStock:0,availableStock:1})} as unknown as InventoryService,verify),
 payments:paymentsApp({get:async()=>({paymentId:id,orderId:id,status:'CREATED',amountPaise:100,currency:'INR'})} as unknown as PaymentService,verify),
};
import {httpContracts as contracts} from '../../contracts/http/v1.js';
describe('consumer HTTP expectations against provider apps',()=>{
 it('search public response and pagination remain compatible',async()=>{const r=await request(search).get('/search/products?q=fixture').expect(200);expect(z.object({data:z.array(z.object({id:z.uuid(),name:z.string(),description:z.string(),priceInPaise:z.number().int()})),pagination:z.object({limit:z.number().int(),nextCursor:z.string().nullable()})}).safeParse(r.body).success).toBe(true);});
 it('search administration requires authentication',async()=>{const r=await request(search).get('/admin/search/index-status').expect(401);expect(error.safeParse(r.body).success).toBe(true);});
 for(const c of contracts){
  it(`${c.provider} required response fields and types`,async()=>{const r=await request(applications[c.provider]).get(c.path).set('authorization','Bearer customer').expect(200);expect(c.schema.safeParse(r.body).success).toBe(true);});
  if(c.auth==='bearer')it(`${c.provider} rejects missing authentication with compatible error`,async()=>{const r=await request(applications[c.provider]).get(c.path).expect(401);expect(error.safeParse(r.body).success).toBe(true);});
 }
 for(const [provider,method,path] of [['catalog','post','/products'],['inventory','put',`/inventory/${id}`],['payments','post','/payments/intents']] as const){
  it(`${provider} preserves administrative authorization`,async()=>{const r=await request(applications[provider])[method](path).set('authorization','Bearer customer').send({}).expect(403);expect(error.safeParse(r.body).success).toBe(true);});
 }
});
const base:Contract={id:'cart-read-v1',consumer:'gateway',provider:'cart',version:1,method:'GET',path:'/cart',authorization:'bearer',status:200,schema:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{productId:{type:'string'},quantity:{type:'integer'}},required:['productId','quantity'],additionalProperties:true}}},required:['items'],additionalProperties:true}};
describe('deterministic compatibility rejection',()=>{
 it('accepts identical provider expectations',()=>expect(compatibility(base,base)).toEqual([]));
 it('allows optional fields for tolerant consumers',()=>expect(compatibility(base,{...base,schema:{...base.schema,properties:{...base.schema.properties,next:{type:'string'}}}})).toEqual([]));
 it('rejects removed required response field',()=>expect(compatibility(base,{...base,schema:{type:'object',properties:{},required:[]}})).not.toEqual([]));
 it('rejects changed response type',()=>expect(compatibility(base,{...base,schema:{type:'string'}})).not.toEqual([]));
 it.each(['public','admin'] as const)('rejects changed authorization %s',authorization=>expect(compatibility(base,{...base,authorization})).not.toEqual([]));
 it('rejects changed event/HTTP version',()=>expect(compatibility(base,{...base,version:2})).not.toEqual([]));
 it('rejects incompatible enum widening',()=>{const c={...base,schema:{type:'string',enum:['PENDING','CONFIRMED']}};expect(compatibility(c,{...c,schema:{type:'string',enum:['PENDING','BROKEN']}})).not.toEqual([]);});
 it('respects strict unknown-field parsing',()=>{const c={...base,schema:{...base.schema,additionalProperties:false}};expect(compatibility(c,{...c,schema:{...c.schema,properties:{...c.schema.properties,extra:{type:'string'}}}})).not.toEqual([]);});
 it('rejects removed required error message',()=>{const c={...base,schema:{type:'object',properties:{error:{type:'object',properties:{message:{type:'string'}},required:['message']}},required:['error']}};expect(compatibility(c,{...c,schema:{type:'object',properties:{error:{type:'string'}},required:['error']}})).not.toEqual([]);});
});
