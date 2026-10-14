import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {transaction} from '@ecommerce/event-persistence';
import {PermanentHandlerError,type Event} from '@ecommerce/messaging';
import {assertNotificationTransition,retryDelay,type NotificationStatus,type NotificationType} from './domain/state-machine.js';
import type {NotificationIntent} from './domain/mapping.js';
import type {EmailContent} from './templates/email.js';
import type {DeliveryResult} from './providers/email-provider.js';
export interface NotificationRow {id:string;source_event_id:string;source_event_type:string;aggregate_key:string;notification_type:NotificationType;channel:'EMAIL';recipient_user_id:string|null;recipient_address:string|null;template_data:unknown;rendered_content:EmailContent|null;template_version:number;status:NotificationStatus;provider_operation_id:string;correlation_id:string;source_order_id:string;attempt_count:number;retry_count:number;reconciliation_count:number;lease_token:string|null;superseded:boolean;last_error_code:string|null;content_purged_at:Date|null;created_at:Date;updated_at:Date}
export interface NotificationClaim {row:NotificationRow;token:string;kind:'SEND'|'LOOKUP';attempt:number}
export class NotificationOperationError extends Error {constructor(readonly status:404|409,message:string){super(message);}}
export const notificationSummary=(r:NotificationRow)=>({notificationId:r.id,sourceEventId:r.source_event_id,notificationType:r.notification_type,channel:r.channel,status:r.status,attemptCount:r.attempt_count,lastErrorCode:r.last_error_code,recipientUserId:r.recipient_user_id,createdAt:r.created_at,updatedAt:r.updated_at});
export class NotificationRepository {
 constructor(readonly pool:Pool,private readonly maxAttempts=5,private readonly baseMs=30000,private readonly leaseMs=30000,private readonly jitter:()=>number=Math.random){}
 async accept(tx:PoolClient,event:Event,intent:NotificationIntent){
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,140014))',[intent.aggregateKey]);
  const prior=(await tx.query('SELECT * FROM notification_outcomes WHERE aggregate_key=$1 FOR UPDATE',[intent.aggregateKey])).rows[0];
  if(prior?.user_id&&intent.userId&&prior.user_id!==intent.userId)throw new PermanentHandlerError();
  if(prior){
   if(prior.outcome==='CANCELLED'&&intent.outcome==='CONFIRMED')return 'stale';
   if(['SUCCEEDED','FAILED'].includes(prior.outcome))return 'stale';
   if(prior.outcome==='MANUAL_REVIEW'&&intent.outcome==='UNKNOWN')return 'stale';
  }
  await tx.query('INSERT INTO notification_outcomes(aggregate_key,outcome,user_id) VALUES($1,$2,$3) ON CONFLICT(aggregate_key) DO UPDATE SET outcome=EXCLUDED.outcome,user_id=COALESCE(notification_outcomes.user_id,EXCLUDED.user_id),updated_at=clock_timestamp()',[intent.aggregateKey,intent.outcome,intent.userId]);
  if(['SUCCEEDED','FAILED','CANCELLED'].includes(intent.outcome)){
   // In-flight delivery retains its real outcome; only work that has not started can be suppressed here.
   const obsolete=(await tx.query<NotificationRow>("SELECT * FROM notifications WHERE aggregate_key=$1 AND notification_type IN ('REFUND_PENDING','ORDER_CONFIRMED') AND notification_type!=$2 FOR UPDATE",[intent.aggregateKey,intent.type])).rows;
   for(const row of obsolete){await tx.query('UPDATE notifications SET superseded=TRUE WHERE id=$1',[row.id]);if(['PENDING','RETRY_SCHEDULED'].includes(row.status)){await this.transition(tx,row,'SUPPRESSED','SUPERSEDED_BUSINESS_OUTCOME');await tx.query('UPDATE notifications SET next_attempt_at=NULL WHERE id=$1',[row.id]);}}
  }
  const created=(await tx.query<NotificationRow>(`INSERT INTO notifications(source_event_id,source_event_type,aggregate_key,notification_type,recipient_user_id,template_data,idempotency_key,correlation_id,source_order_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,[event.eventId,event.eventType,intent.aggregateKey,intent.type,intent.userId,JSON.stringify(intent.data),intent.idempotencyKey,event.correlationId,intent.orderId])).rows[0];
  if(created)await tx.query("INSERT INTO notification_transitions(notification_id,to_state) VALUES($1,'PENDING')",[created.id]);return created?'created':'duplicate';
 }
 private async transition(tx:PoolClient,r:NotificationRow,to:NotificationStatus,code:string|null){if(r.status!==to)assertNotificationTransition(r.status,to);await tx.query('INSERT INTO notification_transitions(notification_id,from_state,to_state,reason_code) VALUES($1,$2,$3,$4)',[r.id,r.status,to,code]);await tx.query(`UPDATE notifications SET status=$2,last_error_code=$3,sent_at=CASE WHEN $2='SENT' THEN COALESCE(sent_at,clock_timestamp()) ELSE sent_at END,updated_at=clock_timestamp() WHERE id=$1`,[r.id,to,code]);}
 async claim(limit=10,workerId=randomUUID()):Promise<NotificationClaim[]>{return transaction(this.pool,async tx=>{
  const rows=(await tx.query<NotificationRow>(`SELECT * FROM notifications WHERE ((status IN ('PENDING','RETRY_SCHEDULED','DELIVERY_UNKNOWN') AND next_attempt_at<=clock_timestamp() AND (locked_until IS NULL OR locked_until<=clock_timestamp())) OR (status='PROCESSING' AND locked_until<=clock_timestamp())) ORDER BY next_attempt_at,created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit])).rows;
  const claims:NotificationClaim[]=[];
  for(const r of rows){if(r.status==='PROCESSING')await tx.query("UPDATE notification_attempts SET status='UNKNOWN',error_code='WORKER_LEASE_EXPIRED',completed_at=clock_timestamp() WHERE notification_id=$1 AND status='PROCESSING'",[r.id]);const token=randomUUID(),kind=r.status==='DELIVERY_UNKNOWN'||r.status==='PROCESSING'?'LOOKUP':'SEND';
   await this.transition(tx,r,'PROCESSING',null);
   const updated=(await tx.query<NotificationRow>(`UPDATE notifications SET lease_token=$2,locked_by=$3,locked_until=clock_timestamp()+$4::integer*INTERVAL '1 millisecond',attempt_count=attempt_count+1 WHERE id=$1 RETURNING *`,[r.id,token,workerId,this.leaseMs])).rows[0]!;
   await tx.query("INSERT INTO notification_attempts(notification_id,attempt_number,provider_operation_id,status,operation_kind) VALUES($1,$2,$3,'PROCESSING',$4)",[r.id,updated.attempt_count,r.provider_operation_id,kind]);
   claims.push({row:updated,token,kind,attempt:updated.attempt_count});
  }return claims;
 });}
 async live(c:NotificationClaim){return (await this.pool.query<NotificationRow>("SELECT * FROM notifications WHERE id=$1 AND lease_token=$2 AND status='PROCESSING' AND locked_until>clock_timestamp()",[c.row.id,c.token])).rows[0];}
 async prepare(c:NotificationClaim,userId:string,email:string,content:EmailContent){return (await this.pool.query(`UPDATE notifications SET recipient_user_id=$3,recipient_address=COALESCE(recipient_address,$4),rendered_content=COALESCE(rendered_content,$5::jsonb) WHERE id=$1 AND lease_token=$2 AND status='PROCESSING' AND locked_until>clock_timestamp() AND NOT superseded RETURNING id`,[c.row.id,c.token,userId,email,JSON.stringify(content)])).rowCount===1;}
 async finish(c:NotificationClaim,result:DeliveryResult|{status:'SUPPRESSED'}|{status:'REVIEW';code:string},durationMs:number,hook:()=>Promise<void>=async()=>{}){return transaction(this.pool,async tx=>{
  const r=(await tx.query<NotificationRow>("SELECT * FROM notifications WHERE id=$1 AND lease_token=$2 AND status='PROCESSING' FOR UPDATE",[c.row.id,c.token])).rows[0];if(!r)return false;
  let status:NotificationStatus,code:string|null=null,attemptStatus:string=result.status;
  if(result.status==='ACCEPTED')status='SENT';
  else if(result.status==='SUPPRESSED'){status='SUPPRESSED';code='SUPERSEDED_BUSINESS_OUTCOME';}
  else if(result.status==='REVIEW'){status='MANUAL_REVIEW_REQUIRED';code=result.code;attemptStatus='UNKNOWN';}
  else if(result.status==='UNKNOWN'){status=r.reconciliation_count+1>=this.maxAttempts?'MANUAL_REVIEW_REQUIRED':'DELIVERY_UNKNOWN';code='AMBIGUOUS_PROVIDER_OUTCOME';}
  else if(result.classification==='PERMANENT'){status='FAILED_PERMANENTLY';code=result.code;}
  else {status=r.superseded?'SUPPRESSED':r.retry_count+1>=this.maxAttempts?'FAILED_PERMANENTLY':'RETRY_SCHEDULED';code=status==='FAILED_PERMANENTLY'?'RETRY_EXHAUSTED':result.code;}
  await this.transition(tx,r,status,code);
  await tx.query(`UPDATE notifications SET lease_token=NULL,locked_by=NULL,locked_until=NULL,
   sent_at=CASE WHEN $2='SENT' THEN clock_timestamp() ELSE NULL END,
   retry_count=retry_count+CASE WHEN $4='NOT_ACCEPTED' THEN 1 ELSE 0 END,reconciliation_count=reconciliation_count+CASE WHEN $4='UNKNOWN' THEN 1 ELSE 0 END,
   next_attempt_at=CASE WHEN $2 IN ('RETRY_SCHEDULED','DELIVERY_UNKNOWN') THEN clock_timestamp()+$3::integer*INTERVAL '1 millisecond' ELSE NULL END WHERE id=$1`,[r.id,status,retryDelay(Math.max(1,r.retry_count+r.reconciliation_count+1),this.baseMs,this.jitter()),attemptStatus]);
  await tx.query('UPDATE notification_attempts SET status=$3,provider_message_id=$4,error_code=$5,completed_at=clock_timestamp(),duration_ms=$6 WHERE notification_id=$1 AND attempt_number=$2',[r.id,c.attempt,attemptStatus,result.status==='ACCEPTED'?result.messageId:null,code,Math.max(0,Math.floor(durationMs))]);await hook();return true;
 });}
 async get(id:string){const row=(await this.pool.query<NotificationRow>('SELECT * FROM notifications WHERE id=$1',[id])).rows[0];if(!row)throw new NotificationOperationError(404,'Notification not found');return row;}
 async list(limit:number,offset:number,status?:string,type?:string){return (await this.pool.query<NotificationRow>('SELECT * FROM notifications WHERE ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR notification_type=$4) ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2',[limit,offset,status??null,type??null])).rows;}
 async attempts(id:string){await this.get(id);return (await this.pool.query('SELECT attempt_number AS "attemptNumber",operation_kind AS "operationKind",status,error_code AS "errorCode",started_at AS "startedAt",completed_at AS "completedAt",duration_ms AS "durationMs" FROM notification_attempts WHERE notification_id=$1 ORDER BY attempt_number DESC LIMIT 100',[id])).rows;}
 async retry(id:string,principal:string,lookup:boolean){const result=await transaction(this.pool,async tx=>{
  const r=(await tx.query<NotificationRow>('SELECT * FROM notifications WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r)return new NotificationOperationError(404,'Notification not found');
  if((r.superseded&&!(['DELIVERY_UNKNOWN','MANUAL_REVIEW_REQUIRED'].includes(r.status)&&lookup))||r.content_purged_at||!['RETRY_SCHEDULED','DELIVERY_UNKNOWN','MANUAL_REVIEW_REQUIRED','FAILED_PERMANENTLY'].includes(r.status)||(['DELIVERY_UNKNOWN','MANUAL_REVIEW_REQUIRED'].includes(r.status)&&!lookup)||(r.status==='FAILED_PERMANENTLY'&&r.last_error_code!=='RETRY_EXHAUSTED'))return new NotificationOperationError(409,'Notification is not safely retryable');
  const state:NotificationStatus=['DELIVERY_UNKNOWN','MANUAL_REVIEW_REQUIRED'].includes(r.status)?'DELIVERY_UNKNOWN':'RETRY_SCHEDULED';
  await tx.query('INSERT INTO notification_retry_audit(notification_id,principal_id,from_state) VALUES($1,$2,$3)',[id,principal,r.status]);
  await tx.query('INSERT INTO notification_transitions(notification_id,from_state,to_state,reason_code) VALUES($1,$2,$3,\'OPERATOR_RETRY\')',[id,r.status,state]);
  await tx.query('UPDATE notifications SET status=$2,retry_count=0,reconciliation_count=0,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1',[id,state]);return {notificationId:id,status:state};
 });if(result instanceof NotificationOperationError)throw result;console.info(JSON.stringify({component:'notification-retry',notificationId:id,outcome:'operator_retry_audited'}));return result;}
 async scrub(days=30){return (await this.pool.query(`UPDATE notifications SET recipient_address=NULL,template_data='{}',rendered_content=NULL,content_purged_at=clock_timestamp() WHERE status IN ('SENT','FAILED_PERMANENTLY','SUPPRESSED') AND updated_at<clock_timestamp()-$1::integer*INTERVAL '1 day' AND content_purged_at IS NULL`,[days])).rowCount;}
 async metrics(){return (await this.pool.query(`SELECT COUNT(*)::integer AS notifications_created_total,COUNT(*) FILTER(WHERE status='SENT')::integer AS notifications_sent_total,(SELECT COUNT(*)::integer FROM notification_transitions WHERE to_state='FAILED_PERMANENTLY') AS notifications_failed_total,(SELECT COUNT(*)::integer FROM notification_transitions WHERE to_state='DELIVERY_UNKNOWN') AS notifications_delivery_unknown_total,COUNT(*) FILTER(WHERE status IN ('PENDING','RETRY_SCHEDULED','DELIVERY_UNKNOWN','PROCESSING'))::integer AS notification_queue_backlog,EXTRACT(EPOCH FROM clock_timestamp()-MIN(created_at) FILTER(WHERE status IN ('PENDING','RETRY_SCHEDULED','DELIVERY_UNKNOWN','PROCESSING'))) AS oldest_pending_notification_age_seconds,(SELECT COUNT(*)::integer FROM notification_transitions WHERE to_state='RETRY_SCHEDULED') AS notifications_retry_total,(SELECT AVG(duration_ms) FROM notification_attempts WHERE completed_at IS NOT NULL) AS notification_delivery_duration_ms FROM notifications`)).rows[0];}
}
