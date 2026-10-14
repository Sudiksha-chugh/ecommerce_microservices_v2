import {z} from 'zod';
import type {ProviderResult} from './payment-repository.js';
export type RefundProviderResult={status:'SUCCEEDED';providerRefundId:string}|{status:'FAILED';failureCode:string}|{status:'UNKNOWN'};
const common=[z.object({status:z.literal('FAILED'),failureCode:z.string().min(1).max(100)}),z.object({status:z.literal('UNKNOWN')})] as const;
const paymentResult=z.discriminatedUnion('status',[z.object({status:z.literal('SUCCEEDED'),providerPaymentId:z.string().min(1).max(255)}),...common]);
const refundResult=z.discriminatedUnion('status',[z.object({status:z.literal('SUCCEEDED'),providerRefundId:z.string().min(1).max(255)}),...common]);
export class ProviderClient {
 constructor(private readonly origin:string,private readonly timeoutMs:number){}
 private async request(path:string,body?:object):Promise<unknown>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  try{const res=await fetch(new URL(path,this.origin),{method:body?'POST':'GET',signal:controller.signal,redirect:'error',headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});if(!res.ok){await res.body?.cancel();return {status:'UNKNOWN'};}return await res.json();}
  catch{return {status:'UNKNOWN'};}finally{clearTimeout(timer);}
 }
 async charge(requestId:string,amountPaise:number,currency:string):Promise<ProviderResult>{const parsed=paymentResult.safeParse(await this.request('/charges',{requestId,amountPaise,currency}));return parsed.success?parsed.data:{status:'UNKNOWN'};}
 async lookup(requestId:string):Promise<ProviderResult>{const parsed=paymentResult.safeParse(await this.request(`/charges/${encodeURIComponent(requestId)}`));return parsed.success?parsed.data:{status:'UNKNOWN'};}
 async refundPayment(operationId:string,paymentRequestId:string,amountPaise:number,currency:string):Promise<RefundProviderResult>{const parsed=refundResult.safeParse(await this.request('/refunds',{operationId,paymentRequestId,amountPaise,currency}));return parsed.success?parsed.data:{status:'UNKNOWN'};}
 async getRefundStatus(operationId:string):Promise<RefundProviderResult>{const parsed=refundResult.safeParse(await this.request(`/refunds/${encodeURIComponent(operationId)}`));return parsed.success?parsed.data:{status:'UNKNOWN'};}
}
