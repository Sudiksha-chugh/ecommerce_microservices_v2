import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Intent } from './validation.js';
import { assertTransition } from './state-machine.js';
import { PaymentDatabaseError, PaymentError } from './errors.js';
export type PaymentStatus = 'CREATED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'REQUIRES_RECONCILIATION';
export type ProviderResult = { status: 'SUCCEEDED'; providerPaymentId: string } | { status: 'FAILED'; failureCode: string } | { status: 'UNKNOWN' };
export interface PaymentRow { id: string; order_id: string; user_id: string; created_by: string; amount_paise: string; currency: 'INR'; status: PaymentStatus; request_fingerprint: string; provider_payment_id: string | null; lease_token: string | null; lease_expires_at: Date | null }
export interface Claim { payment: PaymentRow; token?: string; requestId?: string }
export class PaymentRepository {
 constructor(private readonly pool: Pool, private readonly leaseMs: number, private readonly retryMs: number) {}
 private async tx<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient; try { client = await this.pool.connect(); } catch { throw new PaymentDatabaseError(); }
  let broken = false;
  try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
  catch (error) { try { await client.query('ROLLBACK'); } catch { broken = true; } if (!broken && error instanceof PaymentError) throw error; throw new PaymentDatabaseError(); }
  finally { client.release(broken); }
 }
 async create(principal: string, key: string, input: Intent): Promise<PaymentRow> {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return this.tx(async (client) => {
   const inserted = await client.query<PaymentRow>(`INSERT INTO payments (order_id,user_id,created_by,amount_paise,currency,idempotency_key,request_fingerprint)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`, [input.orderId,input.userId,principal,String(input.amountPaise),input.currency,key,hash]);
   if (inserted.rows[0]) return inserted.rows[0];
   const existing = (await client.query<PaymentRow>('SELECT * FROM payments WHERE created_by=$1 AND idempotency_key=$2 FOR UPDATE', [principal,key])).rows[0];
   if (!existing || existing.request_fingerprint !== hash) throw new PaymentError(409,'Payment request conflicts'); return existing;
  });
 }
 async get(id: string, owner?: string): Promise<PaymentRow> {
  try { const row = (await this.pool.query<PaymentRow>('SELECT * FROM payments WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2)', [id,owner ?? null])).rows[0]; if (!row) throw new PaymentError(404,'Payment not found'); return row; }
  catch (error) { if (error instanceof PaymentError) throw error; throw new PaymentDatabaseError(); }
 }
 async claim(id: string, operation: 'process' | 'reconcile'): Promise<Claim> {
  return this.tx(async (client) => {
   const payment = (await client.query<PaymentRow & { active: boolean }>('SELECT *, lease_expires_at > clock_timestamp() AS active FROM payments WHERE id=$1 FOR UPDATE', [id])).rows[0];
   if (!payment) throw new PaymentError(404,'Payment not found');
   if (payment.status === 'SUCCEEDED' || payment.status === 'FAILED') return { payment };
   if (operation === 'process' && payment.status !== 'CREATED') return { payment };
   if (operation === 'reconcile' && payment.status === 'CREATED') throw new PaymentError(409,'Payment has not been processed');
   if (operation === 'reconcile' && payment.active) return { payment };
   assertTransition(payment.status,operation === 'process' ? 'PROCESSING' : 'REQUIRES_RECONCILIATION');
   const token = randomUUID();
   if (operation === 'process') {
    await client.query("INSERT INTO payment_attempts (payment_id,attempt_number,status,provider_request_id) VALUES ($1::uuid,1,'PROCESSING',$1::text)", [id]);
   } else {
    await client.query("UPDATE payment_attempts SET status='UNKNOWN', updated_at=clock_timestamp() WHERE payment_id=$1 AND status='PROCESSING'", [id]);
   }
   const claimed = (await client.query<PaymentRow>(`UPDATE payments SET status=$2, lease_token=$3, lease_expires_at=clock_timestamp()+$4::integer*INTERVAL '1 millisecond', updated_at=clock_timestamp()
    WHERE id=$1 RETURNING *`, [id, operation === 'process' ? 'PROCESSING' : 'REQUIRES_RECONCILIATION',token,this.leaseMs])).rows[0]!;
   const attempt = (await client.query<{ provider_request_id: string }>('SELECT provider_request_id FROM payment_attempts WHERE payment_id=$1', [id])).rows[0];
   if (!attempt) throw new PaymentDatabaseError(); return { payment: claimed, token, requestId: attempt.provider_request_id };
  });
 }
 async finish(id: string, token: string, result: ProviderResult): Promise<PaymentRow> {
  return this.tx(async (client) => {
   const payment = (await client.query<PaymentRow>('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id])).rows[0];
   if (!payment) throw new PaymentError(404,'Payment not found');
   // A reclaimed lease fences stale network responses and terminal states.
   if (payment.lease_token !== token || !['PROCESSING','REQUIRES_RECONCILIATION'].includes(payment.status)) return payment;
   const status = result.status === 'UNKNOWN' ? 'REQUIRES_RECONCILIATION' : result.status;
   assertTransition(payment.status,status);
   await client.query(`UPDATE payment_attempts SET status=$2, failure_code=$3, updated_at=clock_timestamp() WHERE payment_id=$1`, [id,result.status,result.status === 'FAILED' ? result.failureCode : null]);
   return (await client.query<PaymentRow>(`UPDATE payments SET status=$2, provider_payment_id=$3, lease_token=NULL, lease_expires_at=NULL,
    next_reconcile_at=clock_timestamp()+$4::integer*INTERVAL '1 millisecond', updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id,status,result.status === 'SUCCEEDED' ? result.providerPaymentId : null,this.retryMs])).rows[0]!;
  });
 }
 async pending(limit: number): Promise<string[]> {
  try { return (await this.pool.query<{ id: string }>(`SELECT id FROM payments WHERE status IN ('PROCESSING','REQUIRES_RECONCILIATION')
   AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()) AND next_reconcile_at <= clock_timestamp() ORDER BY next_reconcile_at,id LIMIT $1`, [limit])).rows.map((row) => row.id); }
  catch { throw new PaymentDatabaseError(); }
 }
}
