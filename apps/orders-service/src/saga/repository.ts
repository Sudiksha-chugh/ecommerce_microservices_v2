import {afterCommit,correlation} from '@ecommerce/observability';
import {orderNotificationContext} from '../notification-context.js';
import {OrderError} from '../errors.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {InboxProcessor,insertOutbox,transaction} from '@ecommerce/event-persistence';
import {authorizeSaga,sagaEvent,validateEvent,PermanentHandlerError,type Event,type EventHandler,type SagaKeys} from '@ecommerce/messaging';
import {allowed,type SagaState} from './state-machine.js';
export interface SagaRow {id:string;order_id:string;user_id:string;state:SagaState;version:string;inventory_reservation_id:string|null;payment_id:string|null;reservation_operation_id:string;payment_operation_id:string;correlation_id:string;pending_command:Event|null;retry_count:number;claim_token:string|null;updated_at:Date;cancellation_kind:'CUSTOMER_CANCELLATION'|'PAID_UNFULFILLED'|null;refund_operation_id:string|null;refund_id:string|null;compensation_operation_id:string|null;cancellation_wait:'INVENTORY'|'PAYMENT'|null;refund_amount_paise:string|null}
export function link(s:SagaRow){return {sagaId:s.id,orderId:s.order_id,userId:s.user_id,reservationOperationId:s.reservation_operation_id,paymentOperationId:s.payment_operation_id};}
async function move(client:PoolClient,s:SagaRow,to:SagaState,event?:Event,reason?:string){
 const began=Date.now();
 if(!allowed(s.state,to))throw new Error('Invalid Saga transition');
 const from=s.state;
 await client.query(`INSERT INTO checkout_saga_transitions(saga_id,from_state,to_state,trigger_event_id,reason) VALUES($1,$2,$3,$4,$5)`,[s.id,from,to,event?.eventId??null,reason??null]);
 await client.query(`UPDATE checkout_sagas SET state=$2,version=version+1,updated_at=clock_timestamp(),last_error=$3 WHERE id=$1`,[s.id,to,reason??null]);
 s.state=to;
 if(to==='COMPLETED')afterCommit(client,'order_completed','success');
 if(to==='FAILED'||to==='COMPENSATED')afterCommit(client,'order_failed','error');
 if(['COMPENSATION_PENDING','CANCELLATION_REQUESTED'].includes(to))afterCommit(client,'compensation_started');
 console.info(JSON.stringify({component:'checkout-saga',...correlation(),sagaId:s.id,orderId:s.order_id,correlationId:s.correlation_id,eventId:event?.eventId,causationId:event?.causationId,operationId:event?.eventType.includes('payment')?s.payment_operation_id:s.reservation_operation_id,fromState:from,toState:to,durationMs:Date.now()-began,retryCount:s.retry_count,outcome:'transition_pending_commit'}));
}
async function command(client:PoolClient,s:SagaRow,event:Event){
 await insertOutbox(client,event,s.order_id);
 await client.query(`UPDATE checkout_sagas SET pending_command=$2::jsonb,next_action_at=clock_timestamp()+INTERVAL '30 seconds',retry_count=0,claim_token=NULL,locked_by=NULL,locked_until=NULL WHERE id=$1`,[s.id,JSON.stringify(event)]);
}
export async function startSaga(client:PoolClient,orderId:string,userId:string,items:Array<{productId:string;quantity:number}>,keys:SagaKeys){
 const s=(await client.query<SagaRow>(`INSERT INTO checkout_sagas(order_id,user_id,state,correlation_id) VALUES($1,$2,'CREATED',$3) RETURNING *`,[orderId,userId,randomUUID()])).rows[0]!;
 await client.query("INSERT INTO checkout_saga_transitions(saga_id,to_state,reason) VALUES($1,'CREATED','Authenticated checkout')",[s.id]);
 await move(client,s,'INVENTORY_PENDING');
 await command(client,s,sagaEvent('inventory.reserve.requested',{...link(s),items},keys,s.correlation_id));
}
export class SagaRepository {
 private readonly inbox:InboxProcessor;
 constructor(private readonly pool:Pool,private readonly keys:SagaKeys, private readonly failureHook:(point:'after_claim'|'before_recovery_commit')=>Promise<void>=async()=>{},private readonly refundsEnabled=false){this.inbox=new InboxProcessor(pool);}
 handler:EventHandler=async(input,context)=>{
  const event=authorizeSaga(input,this.keys);
  if(!event.eventType.startsWith('checkout.'))throw new PermanentHandlerError();
  await this.inbox.process('orders.checkout.v1',event,async client=>{
   const p=event.payload;if(!('sagaId' in p)||!('reservationOperationId' in p)||!('paymentOperationId' in p))throw new PermanentHandlerError();
   const s=(await client.query<SagaRow>('SELECT * FROM checkout_sagas WHERE id=$1 FOR UPDATE',[p.sagaId])).rows[0];
   if(!s){console.info(JSON.stringify({component:'checkout-saga',eventId:event.eventId,outcome:'unknown_saga'}));return;}
   if(p.orderId!==s.order_id||p.userId!==s.user_id||p.reservationOperationId!==s.reservation_operation_id||p.paymentOperationId!==s.payment_operation_id||event.correlationId!==s.correlation_id||('reservationId' in p&&p.reservationId!==s.reservation_operation_id)||('paymentId' in p&&s.payment_id&&p.paymentId!==s.payment_id))throw new PermanentHandlerError();
   const reservation={...link(s),reservationId:s.reservation_operation_id};
   if(await this.cancellationOutcome(client,s,event))return;
   switch(event.eventType){
    case 'checkout.inventory.reserved':
     if(s.state!=='INVENTORY_PENDING')break;
     await client.query('UPDATE checkout_sagas SET inventory_reservation_id=$2 WHERE id=$1',[s.id,p.reservationOperationId]);
     await move(client,s,'INVENTORY_RESERVED',event);
     await move(client,s,'PAYMENT_PENDING',event);
     const order=(await client.query<{total_amount_paise:string}>('SELECT total_amount_paise::text FROM orders WHERE id=$1',[s.order_id])).rows[0]!;
     await command(client,s,sagaEvent('payment.process.requested',{...reservation,amountPaise:Number(order.total_amount_paise),currency:'INR'},this.keys,s.correlation_id,event));return;
    case 'checkout.inventory.reservation_failed':
     if(s.state!=='INVENTORY_PENDING')break;
     await move(client,s,'FAILED',event,event.payload.reason);await this.terminal(client,s,'FAILED');return;
    case 'checkout.payment.succeeded':
     if(!['PAYMENT_PENDING','PAYMENT_RECONCILIATION_REQUIRED'].includes(s.state))break;
     const expected=(await client.query('SELECT total_amount_paise::text FROM orders WHERE id=$1',[s.order_id])).rows[0];
     if(!expected||Number(expected.total_amount_paise)!==event.payload.amountPaise)throw new PermanentHandlerError();
     await client.query('UPDATE checkout_sagas SET payment_id=$2 WHERE id=$1',[s.id,event.payload.paymentId]);
     await move(client,s,'PAYMENT_SUCCEEDED',event);await move(client,s,'INVENTORY_CONFIRMATION_PENDING',event);
     await command(client,s,sagaEvent('inventory.confirm.requested',reservation,this.keys,s.correlation_id,event));return;
    case 'checkout.payment.failed':
     if(!['PAYMENT_PENDING','PAYMENT_RECONCILIATION_REQUIRED'].includes(s.state))break;
     await client.query('UPDATE checkout_sagas SET payment_id=$2 WHERE id=$1',[s.id,event.payload.paymentId]);
     await move(client,s,'COMPENSATION_PENDING',event);
     await command(client,s,sagaEvent('inventory.release.requested',reservation,this.keys,s.correlation_id,event));return;
    case 'checkout.payment.reconciliation_required':
     if(s.state!=='PAYMENT_PENDING')break;
     await client.query('UPDATE checkout_sagas SET payment_id=$2 WHERE id=$1',[s.id,event.payload.paymentId]);
     await move(client,s,'PAYMENT_RECONCILIATION_REQUIRED',event);
     // Retain original command and charge operation. Payments owns provider lookups.
     await client.query("UPDATE checkout_sagas SET next_action_at=clock_timestamp()+INTERVAL '30 seconds' WHERE id=$1",[s.id]);return;
    case 'checkout.inventory.confirmed':
     if(s.state!=='INVENTORY_CONFIRMATION_PENDING')break;
     await move(client,s,'COMPLETED',event);await this.terminal(client,s,'CONFIRMED',event);return;
    case 'checkout.inventory.released':
     if(s.state!=='COMPENSATION_PENDING')break;
     await move(client,s,'COMPENSATED',event);await this.terminal(client,s,'FAILED');return;
    case 'checkout.inventory.confirmation_failed':
     if(s.state!=='INVENTORY_CONFIRMATION_PENDING')break;
     await move(client,s,'MANUAL_REVIEW_REQUIRED',event,'Paid reservation could not be confirmed; refund policy deferred to Phase 13');
     await client.query('UPDATE checkout_sagas SET next_action_at=NULL,pending_command=NULL,claim_token=NULL,locked_until=NULL,locked_by=NULL WHERE id=$1',[s.id]);return;
    default:throw new PermanentHandlerError();
   }
   console.info(JSON.stringify({component:'checkout-saga',...correlation(),sagaId:s.id,eventId:event.eventId,state:s.state,outcome:'stale_or_out_of_order'}));
  },context.signal);
 };
 private async terminal(client:PoolClient,s:SagaRow,status:'CONFIRMED'|'FAILED'|'CANCELLED',parent?:Event){
  await client.query('UPDATE orders SET status=$2,updated_at=clock_timestamp() WHERE id=$1',[s.order_id,status]);
  await client.query('UPDATE checkout_sagas SET completed_at=clock_timestamp(),next_action_at=NULL,pending_command=NULL,claim_token=NULL,locked_by=NULL,locked_until=NULL WHERE id=$1',[s.id]);
  if(status==='CONFIRMED'){
   const o=(await client.query('SELECT o.total_amount_paise::text,s.version::text FROM orders o JOIN checkout_sagas s ON s.order_id=o.id WHERE o.id=$1',[s.order_id])).rows[0];
   await insertOutbox(client,sagaEvent('order.confirmed',{orderId:s.order_id,userId:s.user_id,totalAmountPaise:Number(o.total_amount_paise),currency:'INR',confirmedAt:new Date().toISOString(),orderVersion:o.version},this.keys,s.correlation_id,parent),s.order_id);
  }else if(status==='CANCELLED')await insertOutbox(client,sagaEvent('order.cancelled',{orderId:s.order_id,reason:'CUSTOMER_REQUEST',cancelledAt:new Date().toISOString()},this.keys,s.correlation_id,parent),s.order_id);

 }

 private async requestRefund(client:PoolClient,s:SagaRow,parent?:Event){
  if(!s.payment_id||!s.refund_operation_id)throw new Error('Missing cancellation financial linkage');
  const order=(await client.query('SELECT total_amount_paise::text FROM orders WHERE id=$1',[s.order_id])).rows[0];
  await client.query('UPDATE checkout_sagas SET refund_amount_paise=$2 WHERE id=$1',[s.id,order.total_amount_paise]);s.refund_amount_paise=order.total_amount_paise;
  await move(client,s,'REFUND_PENDING',parent);
  await command(client,s,sagaEvent('payment.refund.requested',{...link(s),reservationId:s.reservation_operation_id,refundId:s.refund_operation_id,paymentId:s.payment_id,refundOperationId:s.refund_operation_id,amountPaise:Number(order.total_amount_paise),currency:'INR',reason:s.cancellation_kind!,sagaId:s.id},this.keys,s.correlation_id,parent));
 }
 private async requestInventoryCompensation(client:PoolClient,s:SagaRow,paid:boolean,parent?:Event){
  if(!s.compensation_operation_id)throw new Error('Missing compensation operation');
  await move(client,s,'INVENTORY_RELEASE_PENDING',parent);
  await command(client,s,sagaEvent('inventory.compensate.requested',{...link(s),reservationId:s.reservation_operation_id,compensationOperationId:s.compensation_operation_id,refundOperationId:paid?s.refund_operation_id:null},this.keys,s.correlation_id,parent));
 }
 private async initializeCancellation(client:PoolClient,s:SagaRow,kind:'CUSTOMER_CANCELLATION'|'PAID_UNFULFILLED',parent?:Event){
  const previous=s.state;
  s.cancellation_kind=kind;s.refund_operation_id=randomUUID();s.compensation_operation_id=randomUUID();
  await client.query('UPDATE checkout_sagas SET cancellation_kind=$2,refund_operation_id=$3,compensation_operation_id=$4,completed_at=NULL WHERE id=$1',[s.id,kind,s.refund_operation_id,s.compensation_operation_id]);
  await move(client,s,'CANCELLATION_REQUESTED',parent,kind);
  if(['COMPLETED','INVENTORY_CONFIRMATION_PENDING','PAYMENT_SUCCEEDED','MANUAL_REVIEW_REQUIRED'].includes(previous))await this.requestRefund(client,s,parent);
  else {
   s.cancellation_wait=previous==='INVENTORY_PENDING'?'INVENTORY':'PAYMENT';
   await client.query("UPDATE checkout_sagas SET cancellation_wait=$2,next_action_at=clock_timestamp(),claim_token=NULL,locked_until=NULL,locked_by=NULL WHERE id=$1",[s.id,s.cancellation_wait]);
   await move(client,s,'CANCELLATION_PENDING',parent,'Await authoritative outcome of possibly delivered command');
  }
 }
 async cancel(principal:string,admin:boolean,orderId:string,key:string){
  if(!this.refundsEnabled)throw new OrderError(503,'Refund and cancellation workflows are disabled');
  const fingerprint=createHash('sha256').update(JSON.stringify({orderId,reason:'CUSTOMER_CANCELLATION'})).digest('hex');
  const result=await transaction(this.pool,async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,130013))',[principal+':'+key]);
   const s=(await client.query<SagaRow>('SELECT * FROM checkout_sagas WHERE order_id=$1 AND ($3::boolean OR user_id=$2) FOR UPDATE',[orderId,principal,admin])).rows[0];if(!s)return new OrderError(404,'Checkout order not found');
   const previous=(await client.query('SELECT * FROM cancellation_requests WHERE principal_id=$1 AND idempotency_key=$2',[principal,key])).rows[0];
   if(previous){if(previous.request_fingerprint!==fingerprint)return new OrderError(409,'Cancellation idempotency key conflicts');return {orderId,sagaId:s.id,state:s.state};}
   if(!s.cancellation_kind&&!['INVENTORY_PENDING','INVENTORY_RESERVED','PAYMENT_PENDING','PAYMENT_RECONCILIATION_REQUIRED','PAYMENT_SUCCEEDED','INVENTORY_CONFIRMATION_PENDING','COMPLETED','MANUAL_REVIEW_REQUIRED'].includes(s.state))return new OrderError(409,'Order cannot be cancelled in its current state');
   await client.query('INSERT INTO cancellation_requests(saga_id,principal_id,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4)',[s.id,principal,key,fingerprint]);
   if(!s.cancellation_kind)await this.initializeCancellation(client,s,'CUSTOMER_CANCELLATION');
   return {orderId,sagaId:s.id,state:s.state};
  });if(result instanceof OrderError)throw result;return result;
 }
 private async cancellationOutcome(client:PoolClient,s:SagaRow,event:Event){
  if(event.eventType==='checkout.inventory.fulfillment_impossible'){
   if(!this.refundsEnabled||s.state!=='INVENTORY_CONFIRMATION_PENDING')return true;
   await this.initializeCancellation(client,s,'PAID_UNFULFILLED',event);return true;
  }
  if(event.eventType==='checkout.inventory.compensated'){
   const p=event.payload;
   if(p.compensationOperationId!==s.compensation_operation_id||p.refundOperationId!==(s.refund_id?s.refund_operation_id:null))throw new PermanentHandlerError();
   if(s.state!=='INVENTORY_RELEASE_PENDING')return true;
   if(!s.refund_id&&p.result==='RESTORED')throw new PermanentHandlerError();
   const automatic=s.cancellation_kind==='PAID_UNFULFILLED';await move(client,s,automatic?'COMPENSATED':'CANCELLED',event);await this.terminal(client,s,automatic?'FAILED':'CANCELLED',event);return true;
  }
  if(!s.cancellation_kind)return false;
  if(event.eventType==='checkout.inventory.reserved'&&s.state==='CANCELLATION_PENDING'&&s.cancellation_wait==='INVENTORY'){
   await client.query('UPDATE checkout_sagas SET inventory_reservation_id=$2 WHERE id=$1',[s.id,s.reservation_operation_id]);await this.requestInventoryCompensation(client,s,false,event);return true;
  }
  if(event.eventType==='checkout.inventory.reservation_failed'&&s.state==='CANCELLATION_PENDING'&&s.cancellation_wait==='INVENTORY'){
   await move(client,s,'CANCELLED',event);await this.terminal(client,s,'CANCELLED',event);return true;
  }
  if(event.eventType==='checkout.payment.succeeded'&&s.state==='CANCELLATION_PENDING'&&s.cancellation_wait==='PAYMENT'){
   const expected=(await client.query('SELECT total_amount_paise::text FROM orders WHERE id=$1',[s.order_id])).rows[0];if(BigInt(expected.total_amount_paise)!==BigInt(event.payload.amountPaise))throw new PermanentHandlerError();
   s.payment_id=event.payload.paymentId;await client.query('UPDATE checkout_sagas SET payment_id=$2 WHERE id=$1',[s.id,s.payment_id]);await this.requestRefund(client,s,event);return true;
  }
  if(event.eventType==='checkout.payment.failed'&&s.state==='CANCELLATION_PENDING'&&s.cancellation_wait==='PAYMENT'){
   s.payment_id=event.payload.paymentId;await client.query('UPDATE checkout_sagas SET payment_id=$2 WHERE id=$1',[s.id,s.payment_id]);await this.requestInventoryCompensation(client,s,false,event);return true;
  }
  if(event.eventType==='checkout.payment.reconciliation_required'&&s.state==='CANCELLATION_PENDING'&&s.cancellation_wait==='PAYMENT'){
   await client.query('UPDATE checkout_sagas SET payment_id=$2 WHERE id=$1',[s.id,event.payload.paymentId]);return true;
  }
  // Delayed confirmation is observed but cannot complete a cancellation or replace its refund command.
  return true;
 }
 refundHandler:EventHandler=async(input,context)=>{
  const event=authorizeSaga(input,this.keys);if(!['payment.refund_succeeded','payment.refund_failed','payment.refund_reconciliation_required'].includes(event.eventType))throw new PermanentHandlerError();
  await this.inbox.process('orders.refunds.v1',event,async client=>{
   if(event.eventType!=='payment.refund_succeeded'&&event.eventType!=='payment.refund_failed'&&event.eventType!=='payment.refund_reconciliation_required')throw new PermanentHandlerError();const p=event.payload;
   const recorded=(await client.query('SELECT * FROM order_refunds WHERE refund_id=$1 FOR UPDATE',[p.refundId])).rows[0];
   if(recorded&&(recorded.order_id!==p.orderId||recorded.refund_operation_id!==p.refundOperationId||BigInt(recorded.amount_paise)!==BigInt(p.amountPaise)||recorded.currency!==p.currency))throw new PermanentHandlerError();
   if(!p.sagaId){
    const linked=(await client.query('SELECT s.payment_id,o.user_id,o.total_amount_paise::text FROM checkout_sagas s JOIN orders o ON o.id=s.order_id WHERE o.id=$1 FOR UPDATE OF s',[p.orderId])).rows[0];
    if(!linked)return;if(linked.payment_id!==p.paymentId||linked.user_id!==p.userId||BigInt(p.amountPaise)>BigInt(linked.total_amount_paise))throw new PermanentHandlerError();
    const status=event.eventType==='payment.refund_succeeded'?'SUCCEEDED':event.eventType==='payment.refund_failed'?'FAILED':event.payload.reviewRequired?'MANUAL_REVIEW_REQUIRED':'REQUIRES_RECONCILIATION';
    await client.query(`INSERT INTO order_refunds(refund_id,order_id,refund_operation_id,amount_paise,currency,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(refund_id) DO UPDATE SET status=EXCLUDED.status,updated_at=clock_timestamp() WHERE order_refunds.status NOT IN ('SUCCEEDED','FAILED')`,[p.refundId,p.orderId,p.refundOperationId,String(p.amountPaise),p.currency,status]);return;
   }
   const s=(await client.query<SagaRow>('SELECT * FROM checkout_sagas WHERE id=$1 FOR UPDATE',[p.sagaId])).rows[0];if(!s)return;
   if(p.orderId!==s.order_id||p.userId!==s.user_id||p.paymentId!==s.payment_id||p.refundOperationId!==s.refund_operation_id||p.refundId!==s.refund_operation_id||p.amountPaise!==Number(s.refund_amount_paise)||p.currency!=='INR'||p.reason!==s.cancellation_kind||event.correlationId!==s.correlation_id)throw new PermanentHandlerError();
   const previous=(await client.query('SELECT status FROM order_refunds WHERE refund_id=$1',[p.refundId])).rows[0];
   if(previous&&['SUCCEEDED','FAILED'].includes(previous.status))return;
   const status=event.eventType==='payment.refund_succeeded'?'SUCCEEDED':event.eventType==='payment.refund_failed'?'FAILED':event.payload.reviewRequired?'MANUAL_REVIEW_REQUIRED':'REQUIRES_RECONCILIATION';
   await client.query(`INSERT INTO order_refunds(refund_id,order_id,refund_operation_id,amount_paise,currency,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(refund_id) DO UPDATE SET status=EXCLUDED.status,updated_at=clock_timestamp()`,[p.refundId,s.order_id,p.refundOperationId,String(p.amountPaise),p.currency,status]);
   if(!['REFUND_PENDING','REFUND_RECONCILIATION_REQUIRED','MANUAL_REVIEW_REQUIRED'].includes(s.state))return;
   if(status==='SUCCEEDED'){
    s.refund_id=p.refundId;await client.query('UPDATE checkout_sagas SET refund_id=$2 WHERE id=$1',[s.id,p.refundId]);
    await this.requestInventoryCompensation(client,s,true,event);
   }else if(status==='FAILED'){
    await move(client,s,'CANCELLATION_FAILED',event,'Definitive refund failure; no inventory compensation');await client.query('UPDATE checkout_sagas SET pending_command=NULL,next_action_at=NULL,claim_token=NULL,locked_by=NULL,locked_until=NULL WHERE id=$1',[s.id]);
   }else if(status==='MANUAL_REVIEW_REQUIRED'){
    if(s.state==='REFUND_PENDING')await move(client,s,'REFUND_RECONCILIATION_REQUIRED',event);
    if(s.state!=='MANUAL_REVIEW_REQUIRED')await move(client,s,'MANUAL_REVIEW_REQUIRED',event,'Unknown refund retains capacity; operator lookup required');
    await client.query('UPDATE checkout_sagas SET next_action_at=NULL,claim_token=NULL,locked_by=NULL,locked_until=NULL WHERE id=$1',[s.id]);
   }else if(s.state==='REFUND_PENDING')await move(client,s,'REFUND_RECONCILIATION_REQUIRED',event);
  },context.signal);
 };
 async cancellationStatus(principal:string,admin:boolean,orderId:string){return (await this.pool.query(`SELECT s.order_id AS "orderId",s.id AS "sagaId",s.state,s.cancellation_kind AS reason,o.status AS "orderStatus",s.updated_at AS "updatedAt" FROM checkout_sagas s JOIN orders o ON o.id=s.order_id WHERE s.order_id=$1 AND ($3::boolean OR s.user_id=$2)`,[orderId,principal,admin])).rows[0];}
 async refunds(principal:string,admin:boolean,orderId:string){if(!await this.cancellationStatus(principal,admin,orderId))throw new OrderError(404,'Order not found');return (await this.pool.query('SELECT refund_id AS "refundId",amount_paise::text AS "amountPaise",currency,status,updated_at AS "updatedAt" FROM order_refunds WHERE order_id=$1 ORDER BY updated_at',[orderId])).rows.map(r=>({...r,amountPaise:Number(r.amountPaise)}));}
 async notificationContext(orderId:string){return orderNotificationContext(this.pool,orderId);}
 async status(userId:string,orderId:string){return (await this.pool.query(`SELECT s.order_id AS "orderId",s.id AS "sagaId",s.state,o.status AS "orderStatus",s.updated_at AS "updatedAt" FROM checkout_sagas s JOIN orders o ON o.id=s.order_id WHERE s.order_id=$1 AND s.user_id=$2`,[orderId,userId])).rows[0];}
 async retry(userId:string,orderId:string){return (await this.pool.query(`UPDATE checkout_sagas SET next_action_at=clock_timestamp(),retry_count=0 WHERE order_id=$1 AND user_id=$2 AND state IN ('INVENTORY_PENDING','COMPENSATION_PENDING','INVENTORY_CONFIRMATION_PENDING') AND (locked_until IS NULL OR locked_until<=clock_timestamp()) RETURNING id`,[orderId,userId])).rowCount===1;}
 async recover(limit=10,workerId=randomUUID()){
  const claims=await transaction(this.pool,async client=>(await client.query<SagaRow>(`WITH due AS (SELECT id FROM checkout_sagas WHERE next_action_at<=clock_timestamp() AND retry_count<8 AND (locked_until IS NULL OR locked_until<=clock_timestamp()) ORDER BY next_action_at LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE checkout_sagas s SET locked_by=$2,locked_until=clock_timestamp()+INTERVAL '30 seconds',claim_token=gen_random_uuid() FROM due WHERE s.id=due.id RETURNING s.*`,[limit,workerId])).rows);
  if(claims.length)await this.failureHook('after_claim');
  for(const claim of claims)await transaction(this.pool,async client=>{
   const s=(await client.query<SagaRow>(`SELECT * FROM checkout_sagas WHERE id=$1 AND claim_token=$2 AND locked_until>clock_timestamp() FOR UPDATE`,[claim.id,claim.claim_token])).rows[0];if(!s||!s.pending_command)return;
   const old=validateEvent(s.pending_command);
   // New transport identity; stable business operations, payload and correlation.
   const retry=sagaEvent(old.eventType,old.payload as never,this.keys,s.correlation_id,old);
   await insertOutbox(client,retry,s.order_id);
   await client.query(`UPDATE checkout_sagas SET retry_count=retry_count+1,next_action_at=CASE WHEN retry_count>=7 THEN NULL ELSE clock_timestamp()+$3::integer*INTERVAL '1 millisecond' END,last_error=CASE WHEN retry_count>=7 THEN 'RECOVERY_EXHAUSTED: operator attention; no failure assumed' ELSE last_error END,claim_token=NULL,locked_by=NULL,locked_until=NULL WHERE id=$1 AND claim_token=$2`,[s.id,s.claim_token,Math.min(900000,30000*2**s.retry_count)]);
   await this.failureHook('before_recovery_commit');
  });return claims.length;
 }
 async stats(){return (await this.pool.query(`SELECT state,COUNT(*)::integer AS count,COUNT(*) FILTER(WHERE next_action_at<clock_timestamp() OR last_error LIKE 'RECOVERY_EXHAUSTED%')::integer AS stalled,EXTRACT(EPOCH FROM clock_timestamp()-MIN(created_at)) AS oldest_age_seconds FROM checkout_sagas GROUP BY state`)).rows;}
}
