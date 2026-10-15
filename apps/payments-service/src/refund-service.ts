import type {ProviderClient} from './provider-client.js';
import {RefundRepository,refundView} from './refund-repository.js';
export class RefundService {
 constructor(readonly repository:RefundRepository,private readonly provider:ProviderClient,private readonly failureHook:(point:'after_provider')=>Promise<void>=async()=>{}){}
 async execute(claim:NonNullable<Awaited<ReturnType<RefundRepository['claim']>>>){
  const {refund:r,token}=claim,started=Date.now();
  const result=claim.process?await this.provider.refundPayment(r.provider_operation_id,claim.paymentRequestId,Number(r.amount_paise),r.currency):await this.provider.getRefundStatus(r.provider_operation_id);
  await this.failureHook('after_provider');const outcome=await this.repository.finish(r.id,token,result);
  console.info(JSON.stringify({component:'refund-worker',refundId:r.id,paymentId:r.payment_id,orderId:r.order_id,correlationId:r.correlation_id,refundOperationId:r.provider_operation_id,attemptNumber:1,stateTransition:{from:r.status,to:outcome.status},durationMs:Date.now()-started,outcome:outcome.status}));return refundView(outcome);
 }
 async runOnce(limit=10){const claims=await this.repository.claimBatch(limit);await Promise.all(claims.map(c=>this.execute(c)));return claims.length;}
 async reconcile(id:string){const c=await this.repository.claim(id);return c?this.execute(c):refundView(await this.repository.get(id));}
}
