import type { PaymentRepository, PaymentRow } from './payment-repository.js';
import type { ProviderClient } from './provider-client.js';
import type { Intent } from './validation.js';
export function view(row: PaymentRow) {
 const amountPaise = Number(row.amount_paise); if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Invalid stored payment');
 return { paymentId:row.id,orderId:row.order_id,status:row.status,amountPaise,currency:row.currency };
}
export class PaymentService {
 constructor(private readonly repository: PaymentRepository, private readonly provider: ProviderClient) {}
 async create(principal: string,key: string,input: Intent) { return view(await this.repository.create(principal,key,input)); }
 async get(id: string,owner?: string) { return view(await this.repository.get(id,owner)); }
 async operate(id: string,operation: 'process' | 'reconcile') {
  const claim = await this.repository.claim(id,operation);
  if (!claim.token || !claim.requestId) return view(claim.payment);
  const result = operation === 'process' ? await this.provider.charge(claim.requestId,Number(claim.payment.amount_paise),claim.payment.currency) : await this.provider.lookup(claim.requestId);
  return view(await this.repository.finish(id,claim.token,result));
 }
 async reconcileBatch(limit: number) { const ids = await this.repository.pending(limit); for (const id of ids) await this.operate(id,'reconcile'); return ids.length; }
}
