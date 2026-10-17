import {describe,it,expect,vi} from 'vitest';
import request from 'supertest';
import {z} from 'zod';
import {mutationContracts,mutationErrorSchema,type MutationContract} from '../../contracts/http/mutations-v1.js';
import {mutationCompatibility,type MutationExpectation,type Schema} from '../../packages/resilience-testing/src/index.js';
import {createApp as catalogApp} from '../../apps/catalog-service/src/app.js';
import {createApp as cartApp} from '../../apps/cart-service/src/app.js';
import {createApp as ordersApp} from '../../apps/orders-service/src/app.js';
import {createApp as inventoryApp} from '../../apps/inventory-service/src/app.js';
import {createApp as paymentsApp} from '../../apps/payments-service/src/app.js';
import type {CartService} from '../../apps/cart-service/src/cart-service.js';
import type {OrderService} from '../../apps/orders-service/src/order-service.js';
import type {InventoryService} from '../../apps/inventory-service/src/inventory-service.js';
import type {PaymentService} from '../../apps/payments-service/src/payment-service.js';
import type {RefundService} from '../../apps/payments-service/src/refund-service.js';
import type {SagaRepository} from '../../apps/orders-service/src/saga/repository.js';
import {InvalidTokenError,type TokenVerifier} from '@ecommerce/security';
const id='00000000-0000-4000-8000-000000000001',time='2026-01-01T00:00:00.000Z';
const verify:TokenVerifier=async a=>{if(a!=='Bearer admin'&&a!=='Bearer customer')throw new InvalidTokenError();return {id,role:a==='Bearer admin'?'admin':'customer'};};
const product={id,name:'Contract',description:'Fixture',priceInPaise:100},cart={items:[{productId:id,quantity:1}]};
const order={id,userId:id,status:'PENDING',totalAmountInPaise:100,createdAt:time,updatedAt:time,items:[{productId:id,productName:'Contract',unitPriceInPaise:100,quantity:1,lineTotalInPaise:100}]};
const group=(status:string)=>({orderId:id,status,expiresAt:time,items:[{id,productId:id,quantity:1,status,expiresAt:time}]});
const payment={paymentId:id,orderId:id,status:'SUCCEEDED',amountPaise:100,currency:'INR'};
const refundView={refundId:id,paymentId:id,orderId:id,amountPaise:100,currency:'INR',status:'SUCCEEDED',reason:'ADMIN_REQUEST',createdAt:time,updatedAt:time};
function fixture(){
 const state={fail:false};const call=<T>(value:T)=>vi.fn(async(..._args:unknown[])=>{if(state.fail)throw new Error('controlled contract failure');return value;});
 const orderCreate=call(order),paymentCreate=call({...payment,status:'CREATED'}),refundCreate=call({id,payment_id:id,order_id:id,amount_paise:'100',currency:'INR',status:'REQUESTED',reason:'ADMIN_REQUEST',created_at:new Date(time),updated_at:new Date(time)});
 const catalog={findAll:call([product]),findById:call(product),create:call(product),update:call(product),delete:call(true)};
 const keys={'orders-service':'o'.repeat(32),'inventory-service':'i'.repeat(32),'payments-service':'p'.repeat(32)};
 const apps={
  catalog:catalogApp(catalog,verify),
  cart:cartApp({add:call(cart),update:call(cart),remove:call(undefined),clear:call(undefined)} as unknown as CartService,verify),
  orders:ordersApp({create:orderCreate} as unknown as OrderService,verify,()=> 'ready',{keys,repository:{status:call({sagaId:id,state:'INVENTORY_PENDING'})} as unknown as SagaRepository}),
  inventory:inventoryApp({put:call({productId:id,totalStock:1,reservedStock:0,availableStock:1}),reserve:call(group('RESERVED')),confirm:call(group('CONFIRMED')),release:call(group('RELEASED'))} as unknown as InventoryService,verify),
  payments:paymentsApp({create:paymentCreate,operate:call(payment)} as unknown as PaymentService,verify,()=> 'ready',{repository:{create:refundCreate,get:call({status:'REQUIRES_RECONCILIATION'})},reconcile:call(refundView)} as unknown as RefundService),
 };
 return {apps,state,orderCreate,paymentCreate,refundCreate};
}
const path=(c:MutationContract)=>c.path.replace(/:[A-Za-z]+/g,id);
function invoke(f:ReturnType<typeof fixture>,c:MutationContract,body:unknown=c.sample,authorization:string|null|undefined=c.authorization==='admin'?'Bearer admin':'Bearer customer',key:string|null|undefined=c.idempotency==='principal-key'?'consumer-operation-1':undefined){
 let r=request(f.apps[c.provider])[c.method](path(c));if(authorization)r=r.set('authorization',authorization);if(key)r=r.set('idempotency-key',key);if(body!==undefined)r=r.send(body as object);return r;
}
const schema=(s:z.ZodType)=>z.toJSONSchema(s,{io:'input',unrepresentable:'any'}) as Schema;
function descriptor(c:MutationContract):MutationExpectation{return {id:c.id,version:c.version,consumer:c.consumer,provider:c.provider,method:c.method,path:c.path,authorization:c.authorization,idempotency:c.idempotency,statuses:c.statuses,responseKind:c.responseKind,schema:schema(c.response),requestSchema:schema(c.request),errorSchema:schema(mutationErrorSchema)};}
describe('consumer mutation expectations against actual provider routes',()=>{
 for(const c of mutationContracts){
  it(`${c.id}: request and response wire schemas`,async()=>{const f=fixture();expect(c.request.safeParse(c.sample).success).toBe(true);const r=await invoke(f,c);expect(c.statuses).toContain(r.status);expect(c.response.safeParse(c.responseKind==='empty'?undefined:r.body).success).toBe(true);if(c.responseKind==='empty')expect(r.text).toBe('');});
  it(`${c.id}: missing authentication is rejected compatibly`,async()=>{const r=await invoke(fixture(),c,c.sample,null,null);expect(r.status).toBe(401);expect(mutationErrorSchema.safeParse(r.body).success).toBe(true);});
  if(c.authorization==='admin')it(`${c.id}: customer cannot mutate administrative state`,async()=>{const r=await invoke(fixture(),c,c.sample,'Bearer customer');expect(r.status).toBe(403);expect(mutationErrorSchema.safeParse(r.body).success).toBe(true);});
  if(c.invalid!==undefined)it(`${c.id}: invalid request is rejected by the actual provider`,async()=>{expect(c.request.safeParse(c.invalid).success).toBe(false);const r=await invoke(fixture(),c,c.invalid);expect(r.status).toBe(400);expect(mutationErrorSchema.safeParse(r.body).success).toBe(true);});
  if(c.idempotency==='principal-key'){
   it(`${c.id}: required key cannot be removed`,async()=>{const r=await invoke(fixture(),c,c.sample,c.authorization==='admin'?'Bearer admin':'Bearer customer',null);expect(r.status).toBe(400);expect(mutationErrorSchema.safeParse(r.body).success).toBe(true);});
   it(`${c.id}: stable key is forwarded unchanged on retry`,async()=>{const f=fixture();const first=await invoke(f,c),second=await invoke(f,c);expect(second.body).toEqual(first.body);const spy=c.provider==='orders'?f.orderCreate:c.id==='payments-intent'?f.paymentCreate:f.refundCreate;expect(spy).toHaveBeenCalledTimes(2);expect(spy.mock.calls.map(args=>args[1])).toEqual(['consumer-operation-1','consumer-operation-1']);});
  }
  it(`${c.id}: provider errors retain required error shape`,async()=>{const f=fixture();f.state.fail=true;const r=await invoke(f,c);expect(r.status).toBeGreaterThanOrEqual(400);expect(mutationErrorSchema.safeParse(r.body).success).toBe(true);expect(JSON.stringify(r.body)).not.toContain('controlled contract failure');});
  it(`${c.id}: registry version and idempotency changes are incompatible`,()=>{const d=descriptor(c);expect(mutationCompatibility(d,d)).toEqual([]);expect(mutationCompatibility(d,{...d,version:2})).not.toEqual([]);expect(mutationCompatibility(d,{...d,idempotency:d.idempotency==='none'?'principal-key':'none'})).not.toEqual([]);expect(mutationCompatibility(d,{...d,authorization:'public'})).not.toEqual([]);});
  it(`${c.id}: incompatible error shape is rejected`,()=>{const d=descriptor(c);expect(mutationCompatibility(d,{...d,errorSchema:{type:'string'}})).not.toEqual([]);});
  if(c.responseKind==='json'){
   it(`${c.id}: removed required response field is rejected`,()=>{const d=descriptor(c),required=d.schema.required??[];expect(required.length).toBeGreaterThan(0);expect(mutationCompatibility(d,{...d,schema:{...d.schema,required:required.slice(1)}})).not.toEqual([]);});
   it(`${c.id}: changed response type is rejected`,()=>{const d=descriptor(c);expect(mutationCompatibility(d,{...d,schema:{type:'string'}})).not.toEqual([]);});
   if(c.id.includes('inventory-')&&c.id!=='inventory-stock'||c.provider==='payments'||c.id==='orders-create'||c.id==='checkout-create')it(`${c.id}: unsupported state is rejected`,async()=>{const r=await invoke(fixture(),c);expect(c.response.safeParse({...r.body,status:'INCOMPATIBLE_STATE'}).success).toBe(false);});
  }
 }
 it('rejects provider-required request additions and narrowing types',()=>{const d=descriptor(mutationContracts.find(c=>c.id==='cart-add')!);expect(mutationCompatibility(d,{...d,requestSchema:{...d.requestSchema,required:[...(d.requestSchema.required??[]),'newRequired'],properties:{...d.requestSchema.properties,newRequired:{type:'string'}}}})).not.toEqual([]);expect(mutationCompatibility(d,{...d,requestSchema:{type:'string'}})).not.toEqual([]);});
});
