import type {Pool} from 'pg';
import {InboxProcessor} from '@ecommerce/event-persistence';
import {authorizeSaga,PermanentHandlerError,type EventHandler,type SagaKeys} from '@ecommerce/messaging';
import {RefundRepository} from './refund-repository.js';
import {PaymentError} from './errors.js';
export function refundHandler(pool:Pool,repository:RefundRepository,keys:SagaKeys):EventHandler{
 const inbox=new InboxProcessor(pool);
 return async(input,context)=>{
  const event=authorizeSaga(input,keys);if(event.eventType!=='payment.refund.requested')throw new PermanentHandlerError();
  await inbox.process('payments.refunds.v1',event,async tx=>{
   const p=event.payload;
   try{
    // Capacity rejection is persisted as FAILED by create, so a delayed retry cannot become a refund later.
    const r=await repository.create(p.sagaId,p.refundOperationId,{paymentId:p.paymentId,amountPaise:p.amountPaise,currency:p.currency,reason:p.reason},event,tx);
    await repository.republish(tx,r,event);
   }catch(error){
    // Missing/non-captured payments or invalid linkage contradict the trusted workflow contract.
    // Preserve them for broker/operator review, rather than inventing a financial outcome.
    if(error instanceof PaymentError)throw new PermanentHandlerError();throw error;
   }
  },context.signal);
 };
}
