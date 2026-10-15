import {httpTelemetry} from '@ecommerce/observability';
import {verifyInternalRequest} from '@ecommerce/security';
import type {SagaKeys} from '@ecommerce/messaging';
import type {SagaRepository} from './saga/repository.js';
import express from 'express';
import type { TokenVerifier } from '@ecommerce/security';
import type { OrderService } from './order-service.js';
import { authenticate } from './middleware/authenticate.js';
import { errorHandler } from './middleware/error-handler.js';
import { createOrderBodySchema, idempotencyKeySchema, orderIdSchema, paginationSchema } from './order-validation.js';

export function createApp(orders: OrderService, verify: TokenVerifier, messagingReadiness: () => string = () => 'disabled', checkout?: {repository:SagaRepository;keys:SagaKeys;refundsEnabled?:boolean;lookupKey?:string},internal?:{key:string;lookup:(orderId:string)=>Promise<unknown>}) {
  const app = express();app.use(httpTelemetry('orders-service')); app.disable('x-powered-by');
  app.get('/internal/orders/:orderId/notification-context',async(req,res)=>{
    res.set('Cache-Control','no-store');
    const key=internal?.key??checkout?.lookupKey;
    if(!key||!verifyInternalRequest(req.headers,req.method,req.path,key)){res.status(401).json({error:{message:'Unauthorized'}});return;}
    const id=orderIdSchema.safeParse(req.params.orderId);if(!id.success){res.status(400).json({error:{message:'Invalid order ID'}});return;}
    const order=internal?await internal.lookup(id.data):await checkout!.repository.notificationContext(id.data);if(!order){res.status(404).json({error:{message:'Order unavailable'}});return;}res.json(order);
  });
  app.get('/ready', (_req, res) => { const messaging = messagingReadiness(); res.status(['disabled','ready'].includes(messaging) ? 200 : 503).json({ messaging }); });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'orders-service' }));
  app.use(['/orders','/checkout'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, authenticate(verify));
  app.post('/checkout', express.json(), async(req,res)=>{
    if(!checkout){res.status(503).json({error:{message:'Checkout is disabled'}});return;}
    const key=idempotencyKeySchema.safeParse(req.headers['idempotency-key']);
    if(!key.success||!createOrderBodySchema.safeParse(req.body).success||(req.body===undefined&&(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']!==undefined))){res.status(400).json({error:{message:'Invalid checkout request'}});return;}
    const order=await orders.create(String(res.locals.userId),key.data,String(res.locals.authorization),checkout.keys);
    const status=await checkout.repository.status(String(res.locals.userId),order.id);
    if(!status){res.status(409).json({error:{message:'Idempotency key belongs to a legacy order; use a new checkout key'}});return;}
    res.status(202).location(`/checkout/${order.id}/status`).json({orderId:order.id,sagaId:status.sagaId,status:status.state});
  });
  app.get('/checkout/:orderId/status',async(req,res)=>{
    const id=orderIdSchema.safeParse(req.params.orderId);
    if(!id.success){res.status(400).json({error:{message:'Invalid order ID'}});return;}
    const status=await checkout?.repository.status(String(res.locals.userId),id.data);
    if(!status){res.status(404).json({error:{message:'Checkout not found'}});return;}res.json(status);
  });
  app.post('/checkout/:orderId/retry',express.json(),async(req,res)=>{
    const id=orderIdSchema.safeParse(req.params.orderId);
    if(!id.success||!createOrderBodySchema.safeParse(req.body).success||(req.body===undefined&&(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']!==undefined))){res.status(400).json({error:{message:'Invalid retry request'}});return;}
    const status=await checkout?.repository.status(String(res.locals.userId),id.data);
    if(!status){res.status(404).json({error:{message:'Checkout not found'}});return;}
    if(!await checkout!.repository.retry(String(res.locals.userId),id.data)){res.status(409).json({error:{message:'Checkout is not safely retryable'}});return;}
    res.status(202).json(status);
  });
  app.post('/orders/:orderId/cancel',express.json(),async(req,res)=>{
    if(!checkout?.refundsEnabled){res.status(503).json({error:{message:'Cancellation is disabled'}});return;}
    const id=orderIdSchema.safeParse(req.params.orderId),key=idempotencyKeySchema.safeParse(req.headers['idempotency-key']);
    const unparsed=req.body===undefined&&(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']!==undefined);
    if(!id.success||!key.success||unparsed||!createOrderBodySchema.safeParse(req.body).success){res.status(400).json({error:{message:'Invalid cancellation request'}});return;}
    res.status(202).json(await checkout.repository.cancel(String(res.locals.userId),res.locals.identity.role==='admin',id.data,key.data));
  });
  app.get('/orders/:orderId/cancellation',async(req,res)=>{
    const id=orderIdSchema.safeParse(req.params.orderId);if(!id.success){res.status(400).json({error:{message:'Invalid order ID'}});return;}
    const status=await checkout?.repository.cancellationStatus(String(res.locals.userId),res.locals.identity.role==='admin',id.data);if(!status){res.status(404).json({error:{message:'Order not found'}});return;}res.json(status);
  });
  app.get('/orders/:orderId/refunds',async(req,res)=>{
    const id=orderIdSchema.safeParse(req.params.orderId);if(!id.success){res.status(400).json({error:{message:'Invalid order ID'}});return;}
    if(!checkout){res.status(404).json({error:{message:'Order not found'}});return;}res.json({refunds:await checkout.repository.refunds(String(res.locals.userId),res.locals.identity.role==='admin',id.data)});
  });
  app.post('/orders', express.json(), async (req, res) => {
    const key = idempotencyKeySchema.safeParse(req.headers['idempotency-key']);
    if (!key.success) { res.status(400).json({ error: { message: 'Invalid Idempotency-Key' } }); return; }
    const unparsedBody = req.body === undefined
      && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined);
    if (unparsedBody || !createOrderBodySchema.safeParse(req.body).success) {
      res.status(400).json({ error: { message: 'Order body must be empty' } }); return;
    }
    const order = await orders.create(String(res.locals.userId), key.data, String(res.locals.authorization));
    res.status(201).location(`/orders/${order.id}`).json(order);
  });
  app.get('/orders', async (req, res) => {
    const pagination = paginationSchema.safeParse(req.query);
    if (!pagination.success) { res.status(400).json({ error: { message: 'Invalid pagination' } }); return; }
    const { limit, offset } = pagination.data;
    res.json({ orders: await orders.findAll(String(res.locals.userId), limit, offset), limit, offset });
  });
  app.get('/orders/:id', async (req, res) => {
    const id = orderIdSchema.safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ error: { message: 'Invalid order ID' } }); return; }
    const order = await orders.findById(String(res.locals.userId), id.data);
    if (!order) { res.status(404).json({ error: { message: 'Order not found' } }); return; }
    res.json(order);
  });
  app.use((_req, res) => res.status(404).json({ error: { message: 'Route not found' } }));
  app.use(errorHandler); return app;
}
