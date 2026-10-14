import {randomUUID} from 'node:crypto';
import type {Event} from '../src/index.js';
export const fixture=():Extract<Event,{eventType:"order.created"}> => ({eventId:randomUUID(),eventType:'order.created',eventVersion:1,occurredAt:new Date().toISOString(),producer:'orders-service',correlationId:randomUUID(),causationId:null,payload:{orderId:randomUUID(),userId:randomUUID(),totalAmountPaise:50000,currency:'INR',items:[{productId:randomUUID(),quantity:2}],createdAt:new Date().toISOString()}});
