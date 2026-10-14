import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {validateEvent,expectedProducer,type Event} from './contracts/envelope.js';
import type {EventType,EventPayloads} from './contracts/events.js';
import {PermanentHandlerError} from './errors.js';
export type SagaKeys=Record<'orders-service'|'inventory-service'|'payments-service',string> & Partial<Record<'catalog-service',string>>;
function canonical(value:unknown):unknown {if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='signature').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return value;}
function digest(event:Event,key:string){return createHmac('sha256',key).update(JSON.stringify(canonical(event))).digest('hex');}
export function sagaKeys(env:NodeJS.ProcessEnv=process.env):SagaKeys {const keys={'orders-service':env.SAGA_ORDERS_KEY??'','inventory-service':env.SAGA_INVENTORY_KEY??'','payments-service':env.SAGA_PAYMENTS_KEY??''};if(Object.values(keys).some(k=>k.length<32)||new Set(Object.values(keys)).size!==3)throw new Error('Saga requires three distinct service signing keys of at least 32 characters');return keys;}
export function sagaEvent<T extends EventType>(type:T,payload:EventPayloads[T],keys:SagaKeys,correlationId:string,parent?:Event):Event {const event=validateEvent({eventId:randomUUID(),eventType:type,eventVersion:1,occurredAt:new Date().toISOString(),producer:expectedProducer(type),correlationId,causationId:parent?.eventId??null,payload});const key=keys[event.producer];if(!key||key.length<32)throw new PermanentHandlerError();return {...event,signature:digest(event,key)};}
export function authorizeSaga(input:Event,keys:SagaKeys):Event {const event=validateEvent(input);if(!keys[event.producer]||keys[event.producer]!.length<32||!event.signature||!timingSafeEqual(Buffer.from(event.signature,'hex'),Buffer.from(digest(event,keys[event.producer]??''),'hex')))throw new PermanentHandlerError();return event;}

// Single-producer signing reuses canonical event security without distributing other service keys.
export function signProducerEvent(input:Event,key:string):Event {const event=validateEvent(input);if(key.length<32)throw new Error('Invalid producer signing configuration');return {...event,signature:digest(event,key)};}
export function verifyProducerEvent(input:Event,key:string,producer:Event['producer']):Event {
 const event=validateEvent(input);if(key.length<32||event.producer!==producer||!event.signature||!timingSafeEqual(Buffer.from(event.signature,'hex'),Buffer.from(digest(event,key),'hex')))throw new PermanentHandlerError();return event;
}
