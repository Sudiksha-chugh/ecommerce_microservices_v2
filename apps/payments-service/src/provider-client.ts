import { z } from 'zod';
import type { ProviderResult } from './payment-repository.js';
const resultSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('SUCCEEDED'), providerPaymentId: z.string().min(1).max(255) }), z.object({ status: z.literal('FAILED'), failureCode: z.string().min(1).max(100) }), z.object({ status: z.literal('UNKNOWN') })]);
export class ProviderClient {
 constructor(private readonly origin: string, private readonly timeoutMs: number) {}
 private async request(path: string, body?: object): Promise<ProviderResult> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),this.timeoutMs);
  try { const res = await fetch(new URL(path,this.origin), { method: body ? 'POST' : 'GET', signal: controller.signal, redirect: 'error', headers: body ? { 'content-type':'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
   if (!res.ok) { await res.body?.cancel(); return { status:'UNKNOWN' }; } return resultSchema.parse(await res.json());
  } catch { return { status:'UNKNOWN' }; } finally { clearTimeout(timer); }
 }
 charge(requestId: string, amountPaise: number, currency: string) { return this.request('/charges',{ requestId,amountPaise,currency }); }
 lookup(requestId: string) { return this.request(`/charges/${encodeURIComponent(requestId)}`); }
}
