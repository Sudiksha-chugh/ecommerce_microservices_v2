import {httpTelemetry} from '@ecommerce/observability';
import express from 'express';
import type { TokenVerifier } from '@ecommerce/security';
import type { InventoryService } from './inventory-service.js';
import { uuidSchema, stockSchema, reservationSchema, emptyBodySchema } from './inventory-validation.js';
import { requireAdmin } from './middleware/require-admin.js';
import { errorHandler } from './middleware/error-handler.js';
export function createApp(inventory: InventoryService, verify: TokenVerifier, messagingReadiness: () => string = () => 'disabled') {
  const app = express();app.use(httpTelemetry('inventory-service')); app.disable('x-powered-by');
  app.get('/ready', (_req, res) => { const messaging = messagingReadiness(); res.status(['disabled','ready'].includes(messaging) ? 200 : 503).json({ messaging }); });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'inventory-service' }));
  app.use('/inventory', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/inventory/:productId', async (req, res) => {
    const id = uuidSchema.safeParse(req.params.productId);
    if (!id.success) { res.status(400).json({ error: { message: 'Invalid product ID' } }); return; }
    const stock = await inventory.find(id.data);
    if (!stock) { res.status(404).json({ error: { message: 'Inventory not found' } }); return; }
    res.json(stock);
  });
  app.put('/inventory/:productId', requireAdmin(verify), express.json(), async (req, res) => {
    const id = uuidSchema.safeParse(req.params.productId); const body = stockSchema.safeParse(req.body);
    if (!id.success || !body.success) { res.status(400).json({ error: { message: 'Invalid stock input' } }); return; }
    res.json(await inventory.put(id.data, body.data.totalStock));
  });
  app.post('/inventory/reservations', requireAdmin(verify), express.json(), async (req, res) => {
    const body = reservationSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: { message: 'Invalid reservation input' } }); return; }
    res.status(201).json(await inventory.reserve(body.data));
  });
  for (const action of ['confirm', 'release'] as const) {
    app.post(`/inventory/reservations/:orderId/${action}`, requireAdmin(verify), express.json(), async (req, res) => {
      const id = uuidSchema.safeParse(req.params.orderId);
      const unparsed = req.body === undefined && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined);
      if (!id.success || unparsed || !emptyBodySchema.safeParse(req.body).success) {
        res.status(400).json({ error: { message: 'Invalid reservation transition input' } }); return;
      }
      res.json(await inventory[action](id.data));
    });
  }
  app.use((_req, res) => res.status(404).json({ error: { message: 'Route not found' } }));
  app.use(errorHandler); return app;
}
