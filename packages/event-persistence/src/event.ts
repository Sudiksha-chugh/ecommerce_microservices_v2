import {randomUUID} from 'node:crypto';
import {expectedProducer,validateEvent,type Event,type EventType,type EventPayloads} from '@ecommerce/messaging';
// Internal factory only: never accepts public publication requests. Child events retain workflow identity.
export function createEvent<T extends EventType>(type:T,payload:EventPayloads[T],parent?:Event,occurredAt=new Date().toISOString()):Extract<Event,{eventType:T}>{
 const source=parent?validateEvent(parent):undefined;
 return validateEvent({eventId:randomUUID(),eventType:type,eventVersion:1,occurredAt,
 producer:expectedProducer(type),
 correlationId:source?.correlationId??randomUUID(),causationId:source?.eventId??null,payload}) as Extract<Event,{eventType:T}>;
}
