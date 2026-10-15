import {installRefundRoutes} from './refunds.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { uuid } from '../validation.js';
export const scenarioSchema = z.enum(['success','decline','timeout','temporary-failure','lost-response','ambiguous']);
export type Scenario = z.infer<typeof scenarioSchema>;
// Configuration is server-side only; public request bodies cannot select a result.
export function createMockProvider(pool: Pool,scenario: () => Scenario,delayMs = 2000) {
 const app = express(); app.disable('x-powered-by'); app.use(express.json());
 const bodySchema = z.strictObject({requestId:uuid,amountPaise:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency:z.literal('INR')});
 const view = (row: {status:string;provider_payment_id:string|null;failure_code:string|null}) => row.status === 'SUCCEEDED' ? {status:'SUCCEEDED',providerPaymentId:row.provider_payment_id} : row.status === 'FAILED' ? {status:'FAILED',failureCode:row.failure_code} : {status:'UNKNOWN'};
 app.get('/health',(_req,res) => res.json({status:'ok',service:'mock-payment-provider'}));
 app.post('/charges',async (req,res) => {
  const body = bodySchema.safeParse(req.body); if (!body.success) { res.status(400).json({error:'Invalid charge'}); return; }
  const mode = scenario(); const status = ['success','lost-response','timeout'].includes(mode) ? 'SUCCEEDED' : mode === 'ambiguous' ? 'UNKNOWN' : 'FAILED';
  // Autocommitted in an independently owned database, never the Payments transaction.
  await pool.query(`INSERT INTO mock_charges (request_id,amount_paise,currency,status,provider_payment_id,failure_code)
   VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (request_id) DO NOTHING`, [body.data.requestId,String(body.data.amountPaise),body.data.currency,status,status === 'SUCCEEDED' ? randomUUID() : null,mode === 'decline' ? 'DECLINED' : mode === 'temporary-failure' ? 'TEMPORARY_FAILURE' : null]);
  const row = (await pool.query('SELECT * FROM mock_charges WHERE request_id=$1',[body.data.requestId])).rows[0];
  if (Number(row.amount_paise) !== body.data.amountPaise || row.currency !== body.data.currency) { res.status(409).json({error:'Charge request conflicts'}); return; }
  if (mode === 'timeout') { await new Promise((resolve) => setTimeout(resolve,delayMs)); }
  if (mode === 'lost-response') { res.socket?.destroy(); return; }
  res.json(view(row));
 });
 app.get('/charges/:requestId',async (req,res) => {
  const id = uuid.safeParse(req.params.requestId); if (!id.success) { res.status(400).json({error:'Invalid request ID'}); return; }
  const row = (await pool.query('SELECT * FROM mock_charges WHERE request_id=$1',[id.data])).rows[0]; res.json(row ? view(row) : {status:'UNKNOWN'});
 });
 installRefundRoutes(app,pool,scenario,delayMs);
 app.use(((error: unknown,_req,res,_next) => { console.error('Mock provider request failed'); res.status(500).json({error:'Provider unavailable'}); }) as express.ErrorRequestHandler);
 return app;
}
