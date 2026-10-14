import type {Pool} from 'pg';
import {z} from 'zod';
import type {EventHandler} from '@ecommerce/messaging';
import {PermanentHandlerError} from '@ecommerce/messaging';
import {InboxProcessor} from './processor.js';
export function receiptHandlers(pool:Pool,service:'inventory'|'payments',env:NodeJS.ProcessEnv=process.env):Partial<Record<'inventory.order-created.v1'|'payments.order-created.v1',EventHandler>>{
 const enabled=z.enum(['true','false']).default('false').parse(env.INBOX_ENABLED);if(enabled==='false')return {};
 if(env.MESSAGING_ENABLED!=='true'||env.MESSAGING_DIAGNOSTIC_CONSUMERS==='true')throw new Error('Inbox requires messaging enabled and diagnostic consumers disabled');
 const inbox=new InboxProcessor(pool),name=`${service}.order-created.v1` as const;
 const handler:EventHandler=async (event,context) => {if(event.eventType!=='order.created'||event.eventVersion!==1)throw new PermanentHandlerError();await inbox.process(`${service}.order-created.receipt.v1`,event,async () => {/* Phase 11 receipt only. No stock, payment, or checkout mutation. */},context.signal);};return {[name]:handler};
}
