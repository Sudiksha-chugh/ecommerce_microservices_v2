import { z } from 'zod';
import { payloadSchemas,type EventType,type EventPayloads } from './events.js';
import { PoisonMessageError } from '../errors.js';
export const envelopeSchema=z.strictObject({eventId:z.uuid().transform((v) => v.toLowerCase()),eventType:z.string().min(1).max(100),eventVersion:z.number().int().positive(),occurredAt:z.iso.datetime({offset:true}),producer:z.enum(['orders-service','inventory-service','payments-service','catalog-service']),correlationId:z.uuid().transform((v) => v.toLowerCase()),causationId:z.uuid().transform((v) => v.toLowerCase()).nullable(),signature:z.string().regex(/^[a-f0-9]{64}$/).optional(),payload:z.unknown()}).refine((value) => Object.hasOwn(value,'payload'),'Payload is required');
type Base=Omit<z.infer<typeof envelopeSchema>,'eventType'|'eventVersion'|'payload'>;
export type Event={ [K in EventType]:Base & {eventType:K;eventVersion:1;payload:EventPayloads[K]} }[EventType];
export function validateEvent(value: unknown): Event {
 const envelope=envelopeSchema.safeParse(value);if(!envelope.success)throw new PoisonMessageError('INVALID_ENVELOPE');
 const {eventType,eventVersion,payload,producer}=envelope.data;
 if(eventVersion!==1 || !Object.hasOwn(payloadSchemas,eventType))throw new PoisonMessageError('UNSUPPORTED_EVENT');
 const expected=expectedProducer(eventType);
 if(producer!==expected)throw new PoisonMessageError('INVALID_PRODUCER');
 const parsed=payloadSchemas[eventType as EventType].safeParse(payload);if(!parsed.success)throw new PoisonMessageError('INVALID_PAYLOAD');
 return {...envelope.data,payload:parsed.data} as Event;
}
export function routingKey(event: Event) {return `${event.eventType}.v${event.eventVersion}`;}
export function serialize(event: Event) {return Buffer.from(JSON.stringify(validateEvent(event)));}
export function deserialize(bytes: Buffer): Event {if(bytes.length>100000)throw new PoisonMessageError('MESSAGE_TOO_LARGE');let value:unknown;try {value=JSON.parse(bytes.toString('utf8'));}catch {throw new PoisonMessageError('INVALID_JSON');}return validateEvent(value);}

export function expectedProducer(type:string): 'orders-service'|'inventory-service'|'payments-service'|'catalog-service' { return type.startsWith('catalog.product.')?'catalog-service': type.endsWith('.requested')||type.startsWith('order.')?'orders-service':type.includes('inventory.')?'inventory-service':'payments-service'; }
