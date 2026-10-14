import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {insertOutbox} from '@ecommerce/event-persistence';
import {sagaEvent,validateEvent,type Event,type SagaKeys} from '@ecommerce/messaging';
import {PaymentError} from './errors.js';
import type {RefundProviderResult} from './provider-client.js';
import {assertRefundTransition,type RefundStatus} from './refund-state-machine.js';
export interface RefundInput {paymentId:string;amountPaise:number;currency:'INR';reason:'ADMIN_REQUEST'|'CUSTOMER_CANCELLATION'|'PAID_UNFULFILLED'}
export interface RefundRow {id:string;payment_id:string;order_id:string;user_id:string;amount_paise:string;currency:'INR';status:RefundStatus;reason:RefundInput['reason'];provider_operation_id:string;provider_refund_id:string|null;correlation_id:string;command:Event|null;lease_token:string|null;retry_count:number;request_fingerprint:string;last_error:string|null;created_at:Date;updated_at:Date}
export const refundView=(r:RefundRow)=>({refundId:r.id,paymentId:r.payment_id,orderId:r.order_id,amountPaise:Number(r.amount_paise),currency:r.currency,status:r.status,reason:r.reason,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()});
export class RefundRepository {
 constructor(private readonly pool:Pool,private readonly keys:SagaKeys,private readonly leaseMs=30000,private readonly retryMs=30000,private readonly failureHook:(point:'before_intent_commit'|'after_intent_commit'|'before_outcome_commit'|'after_outcome_commit')=>Promise<void>=async()=>{}){}
 private async tx<T>(effect:(client:PoolClient)=>Promise<T>){const client=await this.pool.connect();let broken=false;const onError=()=>{broken=true;};client.on('error',onError);try{await client.query('BEGIN');const value=await effect(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK').catch(()=>{broken=true;});throw error;}finally{client.release(broken);client.off('error',onError);}}
 async create(principal:string,key:string,input:RefundInput,command?:Extract<Event,{eventType:'payment.refund.requested'}>,client?:PoolClient):Promise<RefundRow>{
  const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const effect=async(tx:PoolClient)=>{
   const replay=async()=>{const r=(await tx.query<RefundRow>('SELECT * FROM refunds WHERE principal_id=$1 AND idempotency_key=$2',[principal,key])).rows[0];if(r&&r.request_fingerprint!==fingerprint)throw new PaymentError(409,'Refund idempotency key conflicts');if(r&&command){const accepted=r.command?validateEvent(r.command):undefined;if(!accepted||JSON.stringify(accepted.payload)!==JSON.stringify(command.payload)||accepted.correlationId!==command.correlationId)throw new PaymentError(409,'Refund workflow linkage conflicts');}return r;};
   const first=await replay();if(first)return first;
   // Every capacity mutation serializes on the captured payment, not an application mutex.
   const payment=(await tx.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[input.paymentId])).rows[0];if(!payment)throw new PaymentError(404,'Payment not found');
   const second=await replay();if(second)return second;
   if(payment.status!=='SUCCEEDED'||payment.currency!==input.currency)throw new PaymentError(409,'Payment is not refundable');
   if(command){
    const original=(await tx.query('SELECT command FROM checkout_payment_intents WHERE payment_id=$1',[payment.id])).rows[0];
    if(!original)throw new PaymentError(409,'Missing checkout payment linkage');const accepted=validateEvent(original.command);
    if(accepted.eventType!=='payment.process.requested')throw new PaymentError(409,'Invalid checkout linkage');
    const a=accepted.payload,p=command.payload;
    if(p.sagaId!==a.sagaId||p.orderId!==payment.order_id||p.userId!==payment.user_id||p.paymentOperationId!==a.paymentOperationId||p.reservationOperationId!==a.reservationOperationId||p.reservationId!==a.reservationId||p.amountPaise!==Number(payment.amount_paise)||p.currency!==payment.currency||command.correlationId!==accepted.correlationId)throw new PaymentError(409,'Refund workflow linkage conflicts');
   }
   const used=BigInt((await tx.query("SELECT COALESCE(SUM(amount_paise),0)::text AS amount FROM refunds WHERE payment_id=$1 AND status!='FAILED'",[payment.id])).rows[0].amount);
   if(!Number.isSafeInteger(input.amountPaise)||input.amountPaise<=0)throw new PaymentError(409,'Invalid refund amount');
   const rejected=used+BigInt(input.amountPaise)>BigInt(payment.amount_paise);
   if(rejected&&!command)throw new PaymentError(409,'Refund exceeds unreserved captured balance');
   const id=command?.payload.refundId??randomUUID(),operation=command?.payload.refundOperationId??id;
   const created=(await tx.query<RefundRow>(`INSERT INTO refunds(id,payment_id,order_id,principal_id,user_id,amount_paise,currency,reason,idempotency_key,request_fingerprint,provider_operation_id,correlation_id,command,status,last_error,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,CASE WHEN $14='FAILED' THEN clock_timestamp() ELSE NULL END) ON CONFLICT DO NOTHING RETURNING *`,[id,payment.id,payment.order_id,principal,payment.user_id,String(input.amountPaise),input.currency,input.reason,key,fingerprint,operation,command?.correlationId??randomUUID(),command?JSON.stringify(command):null,rejected?'FAILED':'REQUESTED',rejected?'CAPACITY_CONFLICT':null])).rows[0];
   if(!created){const existing=await replay();if(!existing)throw new PaymentError(409,'Refund operation conflicts');return existing;}
   await tx.query('INSERT INTO refund_transitions(refund_id,to_state) VALUES($1,$2)',[created.id,created.status]);await this.failureHook('before_intent_commit');return created;
  };
  const result=client?await effect(client):await this.tx(effect);if(!client)await this.failureHook('after_intent_commit');return result;
 }
 async get(id:string,owner?:string){const r=(await this.pool.query<RefundRow>('SELECT * FROM refunds WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2)',[id,owner??null])).rows[0];if(!r)throw new PaymentError(404,'Refund not found');return r;}
 async list(paymentId:string,owner?:string){const p=(await this.pool.query('SELECT id FROM payments WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2)',[paymentId,owner??null])).rows[0];if(!p)throw new PaymentError(404,'Payment not found');return (await this.pool.query<RefundRow>('SELECT * FROM refunds WHERE payment_id=$1 ORDER BY created_at,id',[paymentId])).rows;}
 private async claimRow(tx:PoolClient,r:RefundRow){
  if(['SUCCEEDED','FAILED'].includes(r.status))return undefined;
  const token=randomUUID(),process=r.status==='REQUESTED';
  const state:RefundStatus=process?'PROCESSING':r.status==='MANUAL_REVIEW_REQUIRED'?'MANUAL_REVIEW_REQUIRED':'REQUIRES_RECONCILIATION';
  if(process)await tx.query("INSERT INTO refund_attempts(refund_id,attempt_number,provider_operation_id,status) VALUES($1,1,$2,'PROCESSING')",[r.id,r.provider_operation_id]);
  if(state!==r.status){assertRefundTransition(r.status,state);await tx.query('INSERT INTO refund_transitions(refund_id,from_state,to_state) VALUES($1,$2,$3)',[r.id,r.status,state]);}
  const claimed=(await tx.query<RefundRow>(`UPDATE refunds SET status=$2,lease_token=$3,lease_expires_at=clock_timestamp()+$4::integer*INTERVAL '1 millisecond',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[r.id,state,token,this.leaseMs])).rows[0]!;
  const attempt=(await tx.query('SELECT provider_request_id FROM payment_attempts WHERE payment_id=$1',[r.payment_id])).rows[0];if(!attempt)throw new PaymentError(409,'Captured payment has no provider attempt');
  return {refund:claimed,token,process,paymentRequestId:attempt.provider_request_id as string};
 }
 async claim(id:string){return this.tx(async tx=>{const r=(await tx.query<RefundRow>('SELECT * FROM refunds WHERE id=$1 AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE',[id])).rows[0];return r?this.claimRow(tx,r):undefined;});}
 async claimBatch(limit=10){return this.tx(async tx=>{const rows=(await tx.query<RefundRow>(`SELECT * FROM refunds WHERE status IN ('REQUESTED','PROCESSING','REQUIRES_RECONCILIATION') AND next_action_at<=clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY next_action_at LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit])).rows;const claims=[];for(const r of rows){const c=await this.claimRow(tx,r);if(c)claims.push(c);}return claims;});}
 async emit(tx:PoolClient,r:RefundRow,parent?:Event){
  const command=r.command?validateEvent(r.command):undefined;
  const p={refundId:r.id,paymentId:r.payment_id,orderId:r.order_id,userId:r.user_id,refundOperationId:r.provider_operation_id,amountPaise:Number(r.amount_paise),currency:r.currency,reason:r.reason,sagaId:command&&'sagaId' in command.payload?command.payload.sagaId:null};
  const event=r.status==='SUCCEEDED'?sagaEvent('payment.refund_succeeded',p,this.keys,r.correlation_id,parent??command):r.status==='FAILED'?sagaEvent('payment.refund_failed',{...p,failureCode:(['NOT_REFUNDABLE','CAPACITY_CONFLICT'].includes(r.last_error??'')?r.last_error:'PROVIDER_DECLINED') as 'PROVIDER_DECLINED'|'NOT_REFUNDABLE'|'CAPACITY_CONFLICT'},this.keys,r.correlation_id,parent??command):sagaEvent('payment.refund_reconciliation_required',{...p,reviewRequired:r.status==='MANUAL_REVIEW_REQUIRED'},this.keys,r.correlation_id,parent??command);
  await insertOutbox(tx,event,r.order_id);
  console.info(JSON.stringify({component:'refund-outbox',refundId:r.id,paymentId:r.payment_id,orderId:r.order_id,sagaId:p.sagaId,correlationId:r.correlation_id,eventId:event.eventId,refundOperationId:r.provider_operation_id,attemptNumber:1,outcome:'outcome_pending_commit'}));
 }
 async republish(tx:PoolClient,r:RefundRow,parent:Event){if(['SUCCEEDED','FAILED','REQUIRES_RECONCILIATION','MANUAL_REVIEW_REQUIRED'].includes(r.status))await this.emit(tx,r,parent);}
 async finish(id:string,token:string,result:RefundProviderResult){
  const output=await this.tx(async tx=>{
   const r=(await tx.query<RefundRow>('SELECT * FROM refunds WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r)throw new PaymentError(404,'Refund not found');if(r.lease_token!==token||['SUCCEEDED','FAILED'].includes(r.status))return r;
   const status:RefundStatus=result.status==='UNKNOWN'?(r.retry_count>=7||r.status==='MANUAL_REVIEW_REQUIRED'?'MANUAL_REVIEW_REQUIRED':'REQUIRES_RECONCILIATION'):result.status;
   assertRefundTransition(r.status,status);
   await tx.query('UPDATE refund_attempts SET status=$2,failure_code=$3,updated_at=clock_timestamp() WHERE refund_id=$1',[id,result.status,result.status==='FAILED'?result.failureCode:null]);
   const changed=(await tx.query<RefundRow>(`UPDATE refunds SET status=$2,provider_refund_id=$3,lease_token=NULL,lease_expires_at=NULL,retry_count=retry_count+1,
    next_action_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED','MANUAL_REVIEW_REQUIRED') THEN NULL ELSE clock_timestamp()+$4::integer*INTERVAL '1 millisecond' END,
    completed_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED') THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp(),last_error=$5 WHERE id=$1 RETURNING *`,[id,status,result.status==='SUCCEEDED'?result.providerRefundId:null,Math.min(900000,this.retryMs*2**Math.min(r.retry_count,5)),result.status==='UNKNOWN'?'UNKNOWN_PROVIDER_OUTCOME':result.status==='FAILED'?result.failureCode:null])).rows[0]!;
   if(status!==r.status){await tx.query('INSERT INTO refund_transitions(refund_id,from_state,to_state) VALUES($1,$2,$3)',[id,r.status,status]);}
   await this.emit(tx,changed);
   await this.failureHook('before_outcome_commit');return changed;
  });await this.failureHook('after_outcome_commit');return output;
 }
 async stats(){return (await this.pool.query("SELECT status,COUNT(*)::integer AS count,EXTRACT(EPOCH FROM clock_timestamp()-MIN(created_at)) AS oldest_age_seconds FROM refunds GROUP BY status")).rows;}
}
