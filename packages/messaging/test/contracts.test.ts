import {describe,it,expect} from 'vitest';
import {backoff,bootstrapMessaging,classification,deserialize,PermanentHandlerError,PoisonMessageError,retryCount,retryable,routingKey,serialize,validateEvent,Messaging} from '../src/index.js';
import {fixture} from './fixture.js';
describe('Event contracts',() => {
 it('round-trips the envelope, IDs and payload',() => {const event=fixture();expect(deserialize(serialize(event))).toEqual(event);expect(routingKey(event)).toBe('order.created.v1');});
 it.each(['eventId','eventType','eventVersion','occurredAt','producer','correlationId','causationId','payload'])('requires %s', (field) => {const body:Record<string,unknown>={...fixture()};delete body[field];expect(() => validateEvent(body)).toThrow(PoisonMessageError);});
 it.each([{eventVersion:2},{eventType:'unknown.created'},{producer:'payments-service'},{eventId:'bad'},{correlationId:'bad'},{causationId:'bad'},{occurredAt:'yesterday'},{payload:{}},{extra:'secret'}])('rejects invalid envelope/payload %j', (change) => {expect(() => validateEvent({...fixture(),...change})).toThrow(PoisonMessageError);});
 it('rejects malformed JSON and excessive payload size',() => {expect(() => deserialize(Buffer.from('{'))).toThrow(PoisonMessageError);expect(() => deserialize(Buffer.alloc(100001))).toThrow(PoisonMessageError);});
 it('forbids sensitive provider/internal fields and fractional money',() => {const e=fixture();expect(() => validateEvent({...e,payload:{...e.payload,totalAmountPaise:1.2}})).toThrow();expect(() => validateEvent({...e,payload:{...e.payload,providerSecret:'hidden'}})).toThrow();});
 it.each([
 ['order.cancelled','orders-service',{orderId:fixture().payload.orderId,reason:'PAYMENT_FAILED',cancelledAt:new Date().toISOString()}],
 ['inventory.reserved','inventory-service',{orderId:fixture().payload.orderId,items:fixture().payload.items,expiresAt:new Date().toISOString()}],
 ['inventory.reservation_failed','inventory-service',{orderId:fixture().payload.orderId,reason:'INSUFFICIENT_STOCK',failedAt:new Date().toISOString()}],
 ['inventory.released','inventory-service',{orderId:fixture().payload.orderId,items:fixture().payload.items,releasedAt:new Date().toISOString()}],
 ['payment.succeeded','payments-service',{paymentId:fixture().eventId,orderId:fixture().payload.orderId,amountPaise:1,currency:'INR',succeededAt:new Date().toISOString()}],
 ['payment.failed','payments-service',{paymentId:fixture().eventId,orderId:fixture().payload.orderId,reason:'DECLINED',failedAt:new Date().toISOString()}],
 ['payment.reconciliation_required','payments-service',{paymentId:fixture().eventId,orderId:fixture().payload.orderId,reason:'TIMEOUT',requestedAt:new Date().toISOString()}],
 ])('validates %s v1',(eventType,producer,payload) => {expect(validateEvent({...fixture(),eventType,producer,payload}).eventType).toBe(eventType);});
});
describe('Retry and bootstrap bounds',() => {
 it.each([-1,4,1.5,'1',null,NaN,Infinity])('rejects retry header %s', (value) => {expect(() => retryCount({'retry-count':value})).toThrow(PoisonMessageError);});
 it('accepts bounded counts and retains redelivery count',() => {expect(retryCount(undefined)).toBe(0);expect(retryCount({'retry-count':3,'x-delivery-count':100})).toBe(3);});
 it('classifies permanent, invalid, and temporary failures without logging messages',() => {expect(retryable(new Error('secret'))).toBe(true);expect(retryable(new PermanentHandlerError())).toBe(false);expect(classification(new Error('secret'))).toBe('TRANSIENT_HANDLER_FAILURE');expect(classification(new PoisonMessageError('INVALID_JSON'))).toBe('INVALID_JSON');});
 it('caps exponential backoff and deterministic jitter',() => {expect(backoff(0,100,1000,() => 0)).toBe(100);expect(backoff(20,100,1000,() => 1)).toBe(1000);expect(backoff(3,100,1000,() => 0)).toBe(400);});
 it('defaults bootstrap to disabled with fail-fast publishing',async () => {const bootstrap=bootstrapMessaging('orders',{});expect(bootstrap.readiness()).toBe('disabled');await expect(bootstrap.publish(fixture())).rejects.toThrow('disabled');await bootstrap.stop();});
 it('requires valid application credentials only when enabled',() => {expect(() => bootstrapMessaging('orders',{MESSAGING_ENABLED:'true',MESSAGING_URL:'amqp://guest:guest@localhost'})).toThrow();});
 it('rejects duplicate or unauthorized registrations and closes idle managers',async () => {const m=new Messaging({url:'amqp://app:password@127.0.0.1:1/test'},['inventory'],() => {});m.register('inventory.order-created.v1',async () => {});expect(() => m.register('inventory.order-created.v1',async () => {})).toThrow();expect(() => m.register('orders.payment-events.v1',async () => {})).toThrow();expect(m.status).toBe('idle');await m.stop();expect(m.status).toBe('closed');});
});
