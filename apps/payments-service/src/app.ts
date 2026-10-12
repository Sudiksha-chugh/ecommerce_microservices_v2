import express, { type RequestHandler } from 'express';
import type { Identity, TokenVerifier } from '@ecommerce/security';
import { InvalidTokenError } from '@ecommerce/security';
import type { PaymentService } from './payment-service.js';
import { PaymentError } from './errors.js';
import { emptyBody, intentSchema, keySchema, uuid } from './validation.js';
export function createApp(payments: PaymentService,verify: TokenVerifier) {
 const app = express(); app.disable('x-powered-by'); app.get('/health',(_req,res) => res.json({ status:'ok',service:'payments-service' }));
 const auth: RequestHandler = async (req,res,next) => { try { res.locals.identity = await verify(req.headers.authorization); next(); } catch { res.set('WWW-Authenticate','Bearer').status(401).json({error:{message:'Unauthorized'}}); } };
 const admin: RequestHandler = (_req,res,next) => { if ((res.locals.identity as Identity).role !== 'admin') { res.status(403).json({error:{message:'Forbidden'}}); return; } next(); };
 app.use('/payments',(_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
 app.post('/payments/intents',auth,admin,express.json(),async (req,res) => {
  const body = intentSchema.safeParse(req.body), key = keySchema.safeParse(req.headers['idempotency-key']);
  if (!body.success || !key.success) { res.status(400).json({error:{message:'Invalid payment intent or Idempotency-Key'}}); return; }
  const payment = await payments.create((res.locals.identity as Identity).id,key.data,body.data); res.status(201).location(`/payments/${payment.paymentId}`).json(payment);
 });
 app.get('/payments/:paymentId',auth,async (req,res) => {
  const id = uuid.safeParse(req.params.paymentId); if (!id.success) { res.status(400).json({error:{message:'Invalid payment ID'}}); return; }
  const identity = res.locals.identity as Identity; res.json(await payments.get(id.data,identity.role === 'admin' ? undefined : identity.id));
 });
 for (const action of ['process','reconcile'] as const) app.post(`/payments/:paymentId/${action}`,auth,admin,express.json(),async (req,res) => {
  const id = uuid.safeParse(req.params.paymentId); const unparsed = req.body === undefined && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined);
  if (!id.success || unparsed || !emptyBody.safeParse(req.body).success) { res.status(400).json({error:{message:'Invalid payment operation'}}); return; }
  const payment = await payments.operate(id.data,action); res.status(payment.status === 'PROCESSING' ? 202 : 200).json(payment);
 });
 app.use((_req,res) => res.status(404).json({error:{message:'Route not found'}}));
 app.use(((error: unknown,_req,res,next) => {
  if (res.headersSent) { next(error); return; }
  if (error instanceof PaymentError) { res.status(error.status).json({error:{message:error.message}}); return; }
  if (error instanceof InvalidTokenError) { res.status(401).json({error:{message:'Unauthorized'}}); return; }
  if (typeof error === 'object' && error !== null && 'type' in error) {
   if (error.type === 'entity.parse.failed') { res.status(400).json({error:{message:'Invalid JSON body'}}); return; }
   if (error.type === 'entity.too.large') { res.status(413).json({error:{message:'Request body too large'}}); return; }
  }
  console.error('Payments request failed'); res.status(500).json({error:{message:'Internal server error'}});
 }) as express.ErrorRequestHandler); return app;
}
