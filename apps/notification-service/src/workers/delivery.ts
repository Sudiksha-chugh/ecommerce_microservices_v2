import {NotificationRepository,type NotificationClaim} from '../repository.js';
import {ResolutionError,type RecipientResolver} from '../recipient-resolver.js';
import {renderEmail} from '../templates/email.js';
import type {EmailProvider,DeliveryResult} from '../providers/email-provider.js';
const codes=new Set(['PROVIDER_REJECTED','PROVIDER_REQUEST_CONFLICT','PROVIDER_TEMPORARY_FAILURE','PROVIDER_UNAVAILABLE','PROVIDER_NOT_ACCEPTED']);
function safeResult(result:DeliveryResult):DeliveryResult{return result.status==='NOT_ACCEPTED'?{...result,code:codes.has(result.code)?result.code:result.classification==='PERMANENT'?'PROVIDER_REJECTED':'PROVIDER_TEMPORARY_FAILURE'}:result;}
export class NotificationDeliveryWorker {
 constructor(readonly repository:NotificationRepository,readonly provider:EmailProvider,private readonly resolver:RecipientResolver,private readonly hook:(point:'after_claim'|'before_provider'|'after_provider'|'before_result_commit'|'after_result_commit')=>Promise<void>=async()=>{}){}
 async runOnce(limit=10){const claims=await this.repository.claim(limit);if(claims.length)await this.hook('after_claim');await Promise.all(claims.map(c=>this.execute(c)));return claims.length;}
 private async persist(c:NotificationClaim,result:DeliveryResult|{status:'SUPPRESSED'}|{status:'REVIEW';code:string},began:number){const stored=await this.repository.finish(c,result,Date.now()-began,()=>this.hook('before_result_commit'));await this.hook('after_result_commit');const target=stored?(await this.repository.get(c.row.id)).status:'FENCED';console.info(JSON.stringify({component:'notification-delivery',notificationId:c.row.id,sourceEventId:c.row.source_event_id,notificationType:c.row.notification_type,channel:c.row.channel,providerOperationId:c.row.provider_operation_id,correlationId:c.row.correlation_id,attemptNumber:c.attempt,statusTransition:{from:'PROCESSING',to:target},durationMs:Date.now()-began,outcome:stored?result.status:'stale_claim'}));}
 async execute(c:NotificationClaim){
  const began=Date.now();let row=await this.repository.live(c);if(!row)return;
  if(c.kind==='LOOKUP'){
   if(this.provider.capabilities.statusLookup){let result:DeliveryResult;try{result=safeResult(await this.provider.getDeliveryStatus(row.provider_operation_id));}catch{result={status:'UNKNOWN'};}await this.hook('after_provider');if(result.status==='NOT_ACCEPTED'&&!this.provider.capabilities.idempotentSend)await this.persist(c,{status:'REVIEW',code:'NON_IDEMPOTENT_RESEND_UNSAFE'},began);else await this.persist(c,result,began);}
   else if(row.superseded)await this.persist(c,{status:'REVIEW',code:'SUPERSEDED_DELIVERY_UNRESOLVED'},began);
   else if(this.provider.capabilities.idempotentSend&&row.recipient_address&&row.rendered_content){let result:DeliveryResult;try{result=safeResult(await this.provider.sendEmail({operationId:row.provider_operation_id,recipient:row.recipient_address,content:row.rendered_content}));}catch{result={status:'UNKNOWN'};}await this.hook('after_provider');await this.persist(c,result,began);}
   else await this.persist(c,{status:'REVIEW',code:'PROVIDER_RECONCILIATION_UNSUPPORTED'},began);
   return;
  }
  if(row.superseded){await this.persist(c,{status:'SUPPRESSED'},began);return;}
  try{
   const recipient=await this.resolver.resolve(row.source_order_id,row.recipient_user_id,row.notification_type);
   if(recipient.suppressed){await this.persist(c,{status:'SUPPRESSED'},began);return;}
   const content=row.rendered_content??renderEmail(row.notification_type,row.template_data,row.template_version);
   if(!await this.repository.prepare(c,recipient.userId,row.recipient_address??recipient.email,content)){
    row=await this.repository.live(c);if(row?.superseded)await this.persist(c,{status:'SUPPRESSED'},began);return;
   }
   row=await this.repository.live(c);if(!row)return;if(row.superseded){await this.persist(c,{status:'SUPPRESSED'},began);return;}
  }catch(error){
   const result:DeliveryResult=error instanceof ResolutionError?{status:'NOT_ACCEPTED',classification:error.permanent?'PERMANENT':'TRANSIENT',code:error.code}:{status:'NOT_ACCEPTED',classification:'PERMANENT',code:'INVALID_TEMPLATE'};
   await this.persist(c,result,began);return;
  }
  await this.hook('before_provider');let result:DeliveryResult;
  try{result=safeResult(await this.provider.sendEmail({operationId:row.provider_operation_id,recipient:row.recipient_address!,content:row.rendered_content!}));}catch{result={status:'UNKNOWN'};}
  await this.hook('after_provider');await this.persist(c,result,began);
 }
}
