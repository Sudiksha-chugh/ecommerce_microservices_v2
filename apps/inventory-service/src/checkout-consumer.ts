import {observeBusiness} from '@ecommerce/observability';
import type {Pool} from 'pg';
import {InboxProcessor,insertOutbox} from '@ecommerce/event-persistence';
import {authorizeSaga,sagaEvent,PermanentHandlerError,type EventHandler,type SagaKeys} from '@ecommerce/messaging';
import {InventoryRepository} from './inventory-repository.js';
import {InventoryError} from './errors.js';
export function inventoryCheckoutHandler(pool:Pool,repository:InventoryRepository,keys:SagaKeys, failureHook:(point:'before_commit'|'after_commit')=>Promise<void>=async()=>{}, refundsEnabled=false):EventHandler {
 const inbox=new InboxProcessor(pool);
 return async (input,context)=>{
  const event=authorizeSaga(input,keys);
  if(!['inventory.reserve.requested','inventory.confirm.requested','inventory.release.requested'].includes(event.eventType))throw new PermanentHandlerError();
  let reservationOutcome:'success'|'error'|undefined;
  if(event.eventType==='inventory.reserve.requested')observeBusiness('reservation_attempt');
  const disposition=await inbox.process('inventory.checkout.v1',event,async client=>{
   if(event.eventType==='inventory.reserve.requested'){
    const p=event.payload;
    await client.query('SAVEPOINT reservation');
    try {
     const group=await repository.reserve({orderId:p.orderId,items:p.items},client,true);
     const linked=(await client.query('SELECT * FROM inventory_reservation_requests WHERE order_id=$1 FOR UPDATE',[p.orderId])).rows[0];
     if(linked.saga_id && (linked.saga_id!==p.sagaId||linked.reservation_operation_id!==p.reservationOperationId||linked.saga_user_id!==p.userId||linked.saga_payment_operation_id!==p.paymentOperationId||linked.saga_correlation_id!==event.correlationId))throw new PermanentHandlerError();
     // Existing public reservations cannot be adopted into a new workflow.
     if(!linked.saga_id && group.items.some(i=>i.status!=='RESERVED'))throw new InventoryError(409,'Invalid reservation');
     await client.query(`UPDATE inventory_reservation_requests SET saga_id=$2,reservation_operation_id=$3,saga_user_id=$4,saga_payment_operation_id=$5,saga_correlation_id=$6 WHERE order_id=$1`,[p.orderId,p.sagaId,p.reservationOperationId,p.userId,p.paymentOperationId,event.correlationId]);
     await client.query('UPDATE inventory_reservations SET checkout_hold=TRUE WHERE order_id=$1',[p.orderId]);
     const payload={sagaId:p.sagaId,orderId:p.orderId,userId:p.userId,reservationOperationId:p.reservationOperationId,paymentOperationId:p.paymentOperationId,reservationId:p.reservationOperationId};
     reservationOutcome='success';
     await insertOutbox(client,sagaEvent('checkout.inventory.reserved',payload,keys,event.correlationId,event),p.orderId);
    }catch(error){
     await client.query('ROLLBACK TO SAVEPOINT reservation');
     if(!(error instanceof InventoryError)||![404,409].includes(error.status))throw error;
     reservationOutcome='error';
     await insertOutbox(client,sagaEvent('checkout.inventory.reservation_failed',{sagaId:p.sagaId,orderId:p.orderId,userId:p.userId,reservationOperationId:p.reservationOperationId,paymentOperationId:p.paymentOperationId,reason:error.status===404?'PRODUCT_NOT_FOUND':error.message==='Insufficient stock'?'INSUFFICIENT_STOCK':'CONFLICT'} as never,keys,event.correlationId,event),p.orderId);
    }
   }else if(event.eventType==='inventory.confirm.requested'||event.eventType==='inventory.release.requested'){
    const p=event.payload;
    const linked=(await client.query('SELECT * FROM inventory_reservation_requests WHERE order_id=$1 FOR UPDATE',[p.orderId])).rows[0];
    if(!linked||linked.saga_id!==p.sagaId||linked.reservation_operation_id!==p.reservationOperationId||linked.saga_user_id!==p.userId||linked.saga_payment_operation_id!==p.paymentOperationId||linked.saga_correlation_id!==event.correlationId||p.reservationId!==p.reservationOperationId)throw new PermanentHandlerError();
    try {
     await repository.finish(p.orderId,event.eventType==='inventory.confirm.requested'?'CONFIRMED':'RELEASED',client);
     await insertOutbox(client,sagaEvent(event.eventType==='inventory.confirm.requested'?'checkout.inventory.confirmed':'checkout.inventory.released',p,keys,event.correlationId,event),p.orderId);
    }catch(error){
     if(event.eventType!=='inventory.confirm.requested'||!(error instanceof InventoryError)||error.status!==409)throw error;
     if(refundsEnabled){
      const statuses=(await client.query<{status:string}>('SELECT status FROM inventory_reservations WHERE order_id=$1',[p.orderId])).rows;
      const status=statuses[0]?.status;
      if(status&&['RELEASED','EXPIRED','RESTORED'].includes(status)&&statuses.every(row=>row.status===status)){
       await client.query('UPDATE inventory_reservation_requests SET fulfillment_blocked=TRUE WHERE order_id=$1',[p.orderId]);
       await insertOutbox(client,sagaEvent('checkout.inventory.fulfillment_impossible',{...p,reason:status as 'RELEASED'|'EXPIRED'|'RESTORED'},keys,event.correlationId,event),p.orderId);return;
      }
     }
     await insertOutbox(client,sagaEvent('checkout.inventory.confirmation_failed',{...p,reason:'INVALID_RESERVATION'},keys,event.correlationId,event),p.orderId);
    }
   }
   await failureHook('before_commit');
  },context.signal);
  if(disposition==='processed'&&reservationOutcome)observeBusiness(reservationOutcome==='success'?'reservation_success':'reservation_failure',reservationOutcome);
  await failureHook('after_commit');
 };
}
