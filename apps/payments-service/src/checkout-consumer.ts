import type {Pool,PoolClient} from 'pg';
import {InboxProcessor,insertOutbox,transaction} from '@ecommerce/event-persistence';
import {authorizeSaga,sagaEvent,validateEvent,PermanentHandlerError,type EventHandler,type SagaKeys} from '@ecommerce/messaging';
import type {PaymentRepository,PaymentRow} from './payment-repository.js';
import type {PaymentService} from './payment-service.js';
export function paymentsCheckoutHandler(pool:Pool,repository:PaymentRepository,keys:SagaKeys):EventHandler {
 const inbox=new InboxProcessor(pool);
 return async (input,context)=>{
  const event=authorizeSaga(input,keys);if(event.eventType!=='payment.process.requested')throw new PermanentHandlerError();
  await inbox.process('payments.checkout.v1',event,async client=>{
   const p=event.payload;
   const payment=await repository.create(p.sagaId,p.paymentOperationId,{orderId:p.orderId,userId:p.userId,amountPaise:p.amountPaise,currency:p.currency},client);
   const existing=(await client.query('SELECT * FROM checkout_payment_intents WHERE payment_id=$1 FOR UPDATE',[payment.id])).rows[0];
   if(existing){const previous=validateEvent(existing.command);if(previous.eventType!=='payment.process.requested'||JSON.stringify(previous.payload)!==JSON.stringify(p)||previous.correlationId!==event.correlationId)throw new PermanentHandlerError();
    // A new transport retry may repair an exhausted outcome outbox without creating a charge.
    await client.query('UPDATE checkout_payment_intents SET emitted_status=NULL,next_action_at=clock_timestamp() WHERE payment_id=$1',[payment.id]);
   }
   else {
    if(payment.status!=='CREATED')throw new PermanentHandlerError();
    await client.query('INSERT INTO checkout_payment_intents(payment_id,saga_id,payment_operation_id,command) VALUES($1,$2,$3,$4::jsonb)',[payment.id,p.sagaId,p.paymentOperationId,JSON.stringify(event)]);
   }
  },context.signal);
 };
}
// Called inside the existing fenced outcome transaction. Provider I/O has already finished.
export async function emitCheckoutPayment(client:PoolClient,payment:PaymentRow,keys:SagaKeys){
 const intent=(await client.query('SELECT * FROM checkout_payment_intents WHERE payment_id=$1 FOR UPDATE',[payment.id])).rows[0];
 if(!intent||intent.emitted_status===payment.status||!['SUCCEEDED','FAILED','REQUIRES_RECONCILIATION'].includes(payment.status))return;
 const command=validateEvent(intent.command);if(command.eventType!=='payment.process.requested')throw new Error('Invalid persisted command');
 const {amountPaise,currency,...link}=command.payload;
 const payload={...link,paymentId:payment.id};
 const event=payment.status==='SUCCEEDED'?sagaEvent('checkout.payment.succeeded',{...payload,amountPaise,currency},keys,command.correlationId,command):sagaEvent(payment.status==='FAILED'?'checkout.payment.failed':'checkout.payment.reconciliation_required',payload,keys,command.correlationId,command);
 await insertOutbox(client,event,payment.order_id);
 await client.query('UPDATE checkout_payment_intents SET emitted_status=$2 WHERE payment_id=$1',[payment.id,payment.status]);
}
export async function processCheckoutPayments(pool:Pool,service:PaymentService,keys:SagaKeys,limit=10){
 const rows=(await pool.query(`SELECT p.id,p.status FROM checkout_payment_intents i JOIN payments p ON p.id=i.payment_id
 WHERE i.next_action_at<=clock_timestamp() AND (
 p.status='CREATED' OR
 (p.status IN ('PROCESSING','REQUIRES_RECONCILIATION') AND (p.lease_expires_at IS NULL OR p.lease_expires_at<=clock_timestamp())) OR
 (i.emitted_status IS DISTINCT FROM p.status AND p.status IN ('SUCCEEDED','FAILED')))
 ORDER BY i.next_action_at LIMIT $1`,[limit])).rows;
 for(const row of rows){
  await service.operate(row.id,row.status==='CREATED'?'process':'reconcile');
  await transaction(pool,async client=>{
   const payment=(await client.query<PaymentRow>('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[row.id])).rows[0]!;
   await emitCheckoutPayment(client,payment,keys);
   await client.query("UPDATE checkout_payment_intents SET next_action_at=clock_timestamp()+INTERVAL '30 seconds' WHERE payment_id=$1",[row.id]);
  });
 }
 return rows.length;
}
