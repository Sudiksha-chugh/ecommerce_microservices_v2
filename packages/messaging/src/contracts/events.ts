import { z } from 'zod';
const id=z.uuid().transform((v) => v.toLowerCase());
const time=z.iso.datetime({offset:true});
const money=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const items=z.array(z.strictObject({productId:id,quantity:z.number().int().positive().max(2147483647)})).min(1).max(100).refine((rows) => new Set(rows.map((row) => row.productId)).size===rows.length,'Duplicate products');
const linkage={sagaId:id,orderId:id,userId:id,reservationOperationId:id,paymentOperationId:id};
const outcome={...linkage,reservationId:id};
const refund={refundId:id,paymentId:id,orderId:id,userId:id,refundOperationId:id,amountPaise:money.refine(v=>v>0),currency:z.literal('INR'),reason:z.enum(['ADMIN_REQUEST','CUSTOMER_CANCELLATION','PAID_UNFULFILLED']),sagaId:id.nullable()};
const compensation={...outcome,compensationOperationId:id,refundOperationId:id.nullable()};
export const productProjectionSchema=z.strictObject({id,productVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 name:z.string().min(1).max(255),description:z.string().max(40000).refine(v=>[...v].length<=20000&&Buffer.byteLength(v,'utf8')<=80000),priceInPaise:money,createdAt:time,updatedAt:time,deleted:z.boolean()});
export type ProductProjection=z.infer<typeof productProjectionSchema>;
const productEvent=z.strictObject({productId:id,productVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 changeSequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),product:productProjectionSchema})
 .refine(v=>v.productId===v.product.id&&v.productVersion===v.product.productVersion,'Projection identity/version mismatch');
export const payloadSchemas={
 'catalog.product.created':productEvent.refine(v=>!v.product.deleted),
 'catalog.product.updated':productEvent.refine(v=>!v.product.deleted),
 'catalog.product.deleted':productEvent.refine(v=>v.product.deleted),
 'order.confirmed':z.strictObject({orderId:id,userId:id,totalAmountPaise:money,currency:z.literal('INR'),confirmedAt:time,orderVersion:z.string().regex(/^[0-9]+$/)}),
 'payment.refund.requested':z.strictObject({...refund,...outcome,sagaId:id}),
 'payment.refund_succeeded':z.strictObject(refund),
 'payment.refund_failed':z.strictObject({...refund,failureCode:z.enum(['PROVIDER_DECLINED','NOT_REFUNDABLE','CAPACITY_CONFLICT'])}),
 'payment.refund_reconciliation_required':z.strictObject({...refund,reviewRequired:z.boolean()}),
 'inventory.compensate.requested':z.strictObject(compensation),
 'checkout.inventory.compensated':z.strictObject({...compensation,result:z.enum(['RELEASED','RESTORED','ALREADY_RELEASED','ALREADY_EXPIRED','ALREADY_RESTORED'])}),
 'checkout.inventory.fulfillment_impossible':z.strictObject({...outcome,reason:z.enum(['RELEASED','EXPIRED','RESTORED'])}),
 'inventory.reserve.requested':z.strictObject({...linkage,items}),
 'inventory.confirm.requested':z.strictObject(outcome),
 'inventory.release.requested':z.strictObject(outcome),
 'payment.process.requested':z.strictObject({...outcome,amountPaise:money.refine(v=>v>0),currency:z.literal('INR')}),
 'checkout.inventory.reserved':z.strictObject(outcome),
 'checkout.inventory.reservation_failed':z.strictObject({...linkage,reason:z.enum(['INSUFFICIENT_STOCK','PRODUCT_NOT_FOUND','CONFLICT'])}),
 'checkout.inventory.confirmed':z.strictObject(outcome),
 'checkout.inventory.released':z.strictObject(outcome),
 'checkout.inventory.confirmation_failed':z.strictObject({...outcome,reason:z.literal('INVALID_RESERVATION')}),
 'checkout.payment.succeeded':z.strictObject({...outcome,paymentId:id,amountPaise:money.refine(v=>v>0),currency:z.literal('INR')}),
 'checkout.payment.failed':z.strictObject({...outcome,paymentId:id}),
 'checkout.payment.reconciliation_required':z.strictObject({...outcome,paymentId:id}),
 'order.created':z.strictObject({orderId:id,userId:id,totalAmountPaise:money,currency:z.literal('INR'),items,createdAt:time}),
 'order.cancelled':z.strictObject({orderId:id,reason:z.enum(['CUSTOMER_REQUEST','INVENTORY_UNAVAILABLE','PAYMENT_FAILED','WORKFLOW_TIMEOUT']),cancelledAt:time}),
 'inventory.reserved':z.strictObject({orderId:id,items,expiresAt:time}),
 'inventory.reservation_failed':z.strictObject({orderId:id,reason:z.enum(['INSUFFICIENT_STOCK','PRODUCT_NOT_FOUND','INTERNAL_FAILURE']),failedAt:time}),
 'inventory.released':z.strictObject({orderId:id,items,releasedAt:time}),
 'payment.succeeded':z.strictObject({paymentId:id,orderId:id,amountPaise:money.refine((v) => v>0),currency:z.literal('INR'),succeededAt:time}),
 'payment.failed':z.strictObject({paymentId:id,orderId:id,reason:z.enum(['DECLINED','TEMPORARY_FAILURE','INTERNAL_FAILURE']),failedAt:time}),
 'payment.reconciliation_required':z.strictObject({paymentId:id,orderId:id,reason:z.enum(['TIMEOUT','PROVIDER_UNAVAILABLE','UNKNOWN_RESULT']),requestedAt:time}),
} as const;
export type EventType=keyof typeof payloadSchemas;
export type EventPayloads={ [K in EventType]:z.infer<(typeof payloadSchemas)[K]> };
export type OrderCreatedV1=EventPayloads['order.created'];
export type OrderCancelledV1=EventPayloads['order.cancelled'];
export type InventoryReservedV1=EventPayloads['inventory.reserved'];
export type InventoryReservationFailedV1=EventPayloads['inventory.reservation_failed'];
export type InventoryReleasedV1=EventPayloads['inventory.released'];
export type PaymentSucceededV1=EventPayloads['payment.succeeded'];
export type PaymentFailedV1=EventPayloads['payment.failed'];
export type PaymentReconciliationRequiredV1=EventPayloads['payment.reconciliation_required'];
