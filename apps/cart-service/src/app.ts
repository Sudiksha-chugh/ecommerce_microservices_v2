import express from 'express';
import type { TokenVerifier } from '@ecommerce/security';
import type { CartService } from './cart-service.js';
import { authenticate } from './middleware/authenticate.js';
import { errorHandler } from './middleware/error-handler.js';
import { addItemSchema, updateItemSchema, productIdSchema } from './cart-validation.js';

export function createApp(cart: CartService, verify: TokenVerifier) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'cart-service' }));
  app.use('/cart', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, authenticate(verify));
  app.get('/cart', async (_req, res) => res.json(await cart.find(String(res.locals.userId))));
  app.post('/cart/items', express.json(), async (req, res) => {
    const input = addItemSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: { message: 'Invalid cart item body' } }); return; }
    res.json(await cart.add(String(res.locals.userId), input.data.productId, input.data.quantity));
  });
  app.patch('/cart/items/:productId', express.json(), async (req, res) => {
    const productId = productIdSchema.safeParse(req.params.productId);
    if (!productId.success) { res.status(400).json({ error: { message: 'Invalid product ID' } }); return; }
    const input = updateItemSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: { message: 'Invalid cart item body' } }); return; }
    res.json(await cart.update(String(res.locals.userId), productId.data, input.data.quantity));
  });
  app.delete('/cart/items/:productId', async (req, res) => {
    const productId = productIdSchema.safeParse(req.params.productId);
    if (!productId.success) { res.status(400).json({ error: { message: 'Invalid product ID' } }); return; }
    await cart.remove(String(res.locals.userId), productId.data);
    res.status(204).end();
  });
  app.delete('/cart', async (_req, res) => {
    await cart.clear(String(res.locals.userId));
    res.status(204).end();
  });
  app.use((_req, res) => res.status(404).json({ error: { message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}
