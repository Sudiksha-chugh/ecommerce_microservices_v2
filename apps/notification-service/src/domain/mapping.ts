import {createHash} from 'node:crypto';
import {PermanentHandlerError,type Event} from '@ecommerce/messaging';
import type {NotificationType} from './state-machine.js';
import type {TemplateData} from '../templates/email.js';
export interface NotificationIntent {type:NotificationType;aggregateKey:string;outcome:string;userId:string|null;orderId:string;data:TemplateData;idempotencyKey:string}
export function mapNotification(event:Event):NotificationIntent {
 let type:NotificationType,aggregateKey:string,outcome:string,userId:string|null=null;
 const p=event.payload;if(!('orderId' in p))throw new PermanentHandlerError();const orderId=p.orderId;
 let data:TemplateData={reference:orderId.slice(0,8)};
 switch(event.eventType){
 case 'order.confirmed':type='ORDER_CONFIRMED';aggregateKey=`order:${orderId}`;outcome='CONFIRMED';userId=event.payload.userId;break;
 case 'order.cancelled':type='ORDER_CANCELLED';aggregateKey=`order:${orderId}`;outcome='CANCELLED';break;
 case 'checkout.payment.succeeded':type='PAYMENT_SUCCEEDED';aggregateKey=`payment:${event.payload.paymentId}`;outcome='SUCCEEDED';userId=event.payload.userId;data={...data,amountPaise:event.payload.amountPaise,currency:event.payload.currency};break;
 case 'checkout.payment.failed':type='PAYMENT_FAILED';aggregateKey=`payment:${event.payload.paymentId}`;outcome='FAILED';userId=event.payload.userId;break;
 case 'payment.refund_succeeded':type='REFUND_SUCCEEDED';aggregateKey=`refund:${event.payload.refundId}`;outcome='SUCCEEDED';userId=event.payload.userId;data={...data,amountPaise:event.payload.amountPaise,currency:event.payload.currency};break;
 case 'payment.refund_failed':type='REFUND_FAILED';aggregateKey=`refund:${event.payload.refundId}`;outcome='FAILED';userId=event.payload.userId;break;
 case 'payment.refund_reconciliation_required':type='REFUND_PENDING';aggregateKey=`refund:${event.payload.refundId}`;outcome=event.payload.reviewRequired?'MANUAL_REVIEW':'UNKNOWN';userId=event.payload.userId;break;
 default:throw new PermanentHandlerError();
 }
 // Business operation identity additionally deduplicates new transport IDs produced by recovery.
 const idempotencyKey=createHash('sha256').update(JSON.stringify({aggregateKey,type,channel:'EMAIL',version:1})).digest('hex');
 return {type,aggregateKey,outcome,userId,orderId,data,idempotencyKey};
}
