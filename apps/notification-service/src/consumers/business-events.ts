import type {Pool} from 'pg';
import {InboxProcessor} from '@ecommerce/event-persistence';
import {authorizeSaga,type EventHandler,type SagaKeys} from '@ecommerce/messaging';
import {mapNotification} from '../domain/mapping.js';
import {NotificationRepository} from '../repository.js';
export function notificationHandler(pool:Pool,repository:NotificationRepository,keys:SagaKeys,hook:(point:'before_intent_commit'|'after_intent_commit')=>Promise<void>=async()=>{}):EventHandler{
 const inbox=new InboxProcessor(pool);
 return async(input,context)=>{const began=Date.now(),event=authorizeSaga(input,keys),intent=mapNotification(event);
  await inbox.process('notifications.business-events.v1',event,async tx=>{const outcome=await repository.accept(tx,event,intent);await hook('before_intent_commit');console.info(JSON.stringify({component:'notification-intent',sourceEventId:event.eventId,notificationType:intent.type,channel:'EMAIL',correlationId:event.correlationId,durationMs:Date.now()-began,outcome:`${outcome}_pending_commit`}));},context.signal);
  await hook('after_intent_commit');
 };
}
