import {describe,it,expect} from 'vitest';
import request from 'supertest';
import {createApp as ordersApp} from '../../../apps/orders-service/src/app.js';
import {createApp as inventoryApp} from '../../../apps/inventory-service/src/app.js';
import {createApp as paymentsApp} from '../../../apps/payments-service/src/app.js';
import type {OrderService} from '../../../apps/orders-service/src/order-service.js';
import type {InventoryService} from '../../../apps/inventory-service/src/inventory-service.js';
import type {PaymentService} from '../../../apps/payments-service/src/payment-service.js';
const unused=new Proxy({}, {get(){throw new Error('Readiness must not invoke business dependencies');}});
const verify=async () => {throw new Error('Readiness should be public');};
const factories=[(status:() => string) => ordersApp(unused as OrderService,verify,status),(status:() => string) => inventoryApp(unused as InventoryService,verify,status),(status:() => string) => paymentsApp(unused as PaymentService,verify,status)];
describe('Service messaging readiness without workflow activation',() => {
 it.each([0,1,2])('reports disabled/ready/reconnecting for service %i without business calls',async (index) => {for(const state of ['disabled','ready','reconnecting','closed']){const app=factories[index]!(() => state);expect((await request(app).get('/ready').expect(['disabled','ready'].includes(state)?200:503)).body).toEqual({messaging:state});await request(app).get('/health').expect(200);}});
});

describe('Explicit queue selection preserves ownership and default registrations',()=>{
 it('rejects an undeclared owned consumer and unknown queues while preserving the default topology',async()=>{
  const {Messaging}=await import('../src/index.js');const url='amqp://test:password@127.0.0.1:1/commerce_test';
  const selected=new Messaging({url,queues:['inventory.order-created.v1']},['inventory'],()=>{});
  expect(()=>selected.register('inventory.order-created.v1',async()=>{})).not.toThrow();
  expect(()=>selected.register('inventory.checkout-commands.v1',async()=>{})).toThrow();
  expect(()=>selected.register('payments.order-created.v1',async()=>{})).toThrow();
  expect(()=>new Messaging({url,queues:['unknown.queue' as 'inventory.order-created.v1']},['inventory'],()=>{})).toThrow();
  const standard=new Messaging({url},['inventory'],()=>{});expect(()=>standard.register('inventory.checkout-commands.v1',async()=>{})).not.toThrow();
 });
});
