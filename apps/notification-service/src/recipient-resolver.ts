import {telemetryFetch} from '@ecommerce/observability';
import {z} from 'zod';
import {internalHeaders} from '@ecommerce/security';
import type {NotificationType} from './domain/state-machine.js';
export class ResolutionError extends Error {constructor(readonly code:string,readonly permanent=false){super('Notification context unavailable');}}
const orderSchema=z.strictObject({orderId:z.uuid(),userId:z.uuid(),status:z.enum(['PENDING','CONFIRMED','FAILED','CANCELLED']),amountPaise:z.string().regex(/^\d+$/),version:z.string().regex(/^\d+$/)});
const contactSchema=z.strictObject({userId:z.uuid(),email:z.email().max(320)});
export class RecipientResolver {
 constructor(private readonly authOrigin:string,private readonly ordersOrigin:string,private readonly key:string,private readonly timeoutMs=3000){}
 private async get(origin:string,path:string):Promise<unknown>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  try{const res=await telemetryFetch(new URL(path,origin),{redirect:'error',signal:controller.signal,headers:internalHeaders('GET',path,this.key)});if(!res.ok){await res.body?.cancel();throw new ResolutionError(res.status===404?'RECIPIENT_CONTEXT_NOT_FOUND':'LOOKUP_UNAVAILABLE',res.status===404);}return await res.json();}
  catch(error){if(error instanceof ResolutionError)throw error;throw new ResolutionError('LOOKUP_UNAVAILABLE');}finally{clearTimeout(timer);}
 }
 async resolve(orderId:string,claimedUser:string|null,type:NotificationType){
  const parsed=orderSchema.safeParse(await this.get(this.ordersOrigin,`/internal/orders/${encodeURIComponent(orderId)}/notification-context`));if(!parsed.success)throw new ResolutionError('INVALID_ORDER_CONTEXT',true);const order=parsed.data;
  if(order.orderId!==orderId||(claimedUser&&claimedUser!==order.userId))throw new ResolutionError('RECIPIENT_LINKAGE_MISMATCH',true);
  if((type==='ORDER_CONFIRMED'&&order.status!=='CONFIRMED')||(type==='ORDER_CANCELLED'&&order.status!=='CANCELLED'))return {suppressed:true as const,userId:order.userId};
  const contact=contactSchema.safeParse(await this.get(this.authOrigin,`/internal/users/${order.userId}/contact`));if(!contact.success)throw new ResolutionError('INVALID_RECIPIENT',true);if(contact.data.userId!==order.userId)throw new ResolutionError('RECIPIENT_LINKAGE_MISMATCH',true);
  return {suppressed:false as const,userId:order.userId,email:contact.data.email};
 }
}
