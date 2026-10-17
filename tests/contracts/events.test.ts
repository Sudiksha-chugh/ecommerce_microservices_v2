import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {z} from 'zod';
import {payloadSchemas,expectedProducer,validateEvent} from '@ecommerce/messaging';
import {compatibility,type Contract} from '../../packages/resilience-testing/src/index.js';
const pinned=JSON.parse(readFileSync(new URL('../../contracts/events/v1.json',import.meta.url),'utf8')) as Contract[];
const id='00000000-0000-4000-8000-000000000001';
const valid={eventId:id,eventType:'payment.succeeded',eventVersion:1,occurredAt:'2026-01-01T00:00:00.000Z',producer:'payments-service',correlationId:id,causationId:null,payload:{paymentId:id,orderId:id,amountPaise:100,currency:'INR',succeededAt:'2026-01-01T00:00:00.000Z'}};
describe('pinned consumer event registry',()=>{
 it('covers every provider event, including notifications and search',()=>expect(pinned.map(c=>c.id).sort()).toEqual(Object.keys(payloadSchemas).sort()));
 for(const contract of pinned)it(`${contract.id} v1 provider retains pinned expectations`,()=>{
  const schema=payloadSchemas[contract.id as keyof typeof payloadSchemas];
  const current={...contract,provider:expectedProducer(contract.id),schema:z.toJSONSchema(schema,{io:'input',unrepresentable:'any'}) as Contract['schema']};
  expect(compatibility(contract,current)).toEqual([]);
 });
 it('accepts an actual valid envelope',()=>expect(validateEvent(valid).eventVersion).toBe(1));
 it.each([
  {...valid,eventVersion:undefined}, {...valid,eventVersion:2}, {...valid,eventType:'unsupported.event'},
  {...valid,producer:'catalog-service'}, {...valid,payload:{...valid.payload,amountPaise:'100'}},
  {...valid,payload:{...valid.payload,currency:'USD'}}, {...valid,payload:{...valid.payload,extra:true}},
  {...valid,payload:{orderId:id}}, {...valid,eventId:undefined},
 ])('rejects incompatible event fixture %#',fixture=>expect(()=>validateEvent(fixture)).toThrow());
 it('rejects provider removal of required event fields in compatibility check',()=>{const c=pinned.find(c=>c.id==='payment.succeeded')!;expect(compatibility(c,{...c,schema:{...c.schema,required:[]}})).not.toEqual([]);});
});
