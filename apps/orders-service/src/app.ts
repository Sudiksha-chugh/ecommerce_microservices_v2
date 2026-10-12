import express from 'express';
import type { TokenVerifier } from '@ecommerce/security';
import type { OrderService } from './order-service.js';
import { authenticate } from './middleware/authenticate.js';
import { errorHandler } from './middleware/error-handler.js';
import { createOrderBodySchema, idempotencyKeySchema, orderIdSchema, paginationSchema } from './order-validation.js';

export function createApp(orders: OrderService, verify: TokenVerifier) {
  const app = express(); app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'orders-service' }));
  app.use('/orders', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, authenticate(verify));
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
