import type {Pool} from 'pg';
import {InboxProcessor,insertOutbox} from '@ecommerce/event-persistence';
import {authorizeSaga,sagaEvent,PermanentHandlerError,type SagaKeys,type EventHandler} from '@ecommerce/messaging';
import type {InventoryRepository} from './inventory-repository.js';
export function compensationHandler(pool:Pool,repository:InventoryRepository,keys:SagaKeys,hook:(point:'before_commit'|'after_commit')=>Promise<void>=async()=>{}):EventHandler{
 const inbox=new InboxProcessor(pool);
 return async(input,context)=>{
  const event=authorizeSaga(input,keys);if(event.eventType!=='inventory.compensate.requested')throw new PermanentHandlerError();const p=event.payload;
  await inbox.process('inventory.compensation.v1',event,async tx=>{
   const request=(await tx.query('SELECT * FROM inventory_reservation_requests WHERE order_id=$1 FOR UPDATE',[p.orderId])).rows[0];
   if(!request||request.saga_id!==p.sagaId||request.saga_user_id!==p.userId||request.reservation_operation_id!==p.reservationOperationId||request.saga_payment_operation_id!==p.paymentOperationId||request.saga_correlation_id!==event.correlationId||p.reservationId!==p.reservationOperationId)throw new PermanentHandlerError();
   const old=(await tx.query('SELECT * FROM inventory_compensations WHERE order_id=$1',[p.orderId])).rows[0];
   if(old&&(old.compensation_operation_id!==p.compensationOperationId||old.refund_operation_id!==p.refundOperationId))throw new PermanentHandlerError();
   const result=old?.result??await repository.compensate(p.orderId,p.refundOperationId!==null,tx);
   if(!old)await tx.query('INSERT INTO inventory_compensations(order_id,compensation_operation_id,saga_id,user_id,refund_operation_id,result) VALUES($1,$2,$3,$4,$5,$6)',[p.orderId,p.compensationOperationId,p.sagaId,p.userId,p.refundOperationId,result]);
   await tx.query('UPDATE inventory_reservation_requests SET fulfillment_blocked=TRUE WHERE order_id=$1',[p.orderId]);
   await insertOutbox(tx,sagaEvent('checkout.inventory.compensated',{...p,result},keys,event.correlationId,event),p.orderId);await hook('before_commit');
  },context.signal);await hook('after_commit');
 };
}
