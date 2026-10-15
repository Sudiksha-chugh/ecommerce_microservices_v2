import express, { type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { createProxyTrust, rateLimitMiddleware, RateLimitMetrics, type ProtectionOptions } from '@ecommerce/rate-limiting';
import { loadGatewayEnvironment, type GatewayEnvironment } from '@ecommerce/config';
import { requestUpstream } from './upstream-client.js';
import type { ErrorResponse, HealthResponse } from '@ecommerce/contracts';
import { errorHandler } from './middleware/error-handler.js';

type GatewayOptions = Pick<GatewayEnvironment, 'CATALOG_SERVICE_URL' | 'CATALOG_REQUEST_TIMEOUT_MS'>
  & Partial<Pick<GatewayEnvironment, 'AUTH_SERVICE_URL' | 'AUTH_REQUEST_TIMEOUT_MS' | 'CART_SERVICE_URL' | 'CART_REQUEST_TIMEOUT_MS' | 'ORDERS_SERVICE_URL' | 'ORDERS_REQUEST_TIMEOUT_MS' | 'INVENTORY_SERVICE_URL' | 'INVENTORY_REQUEST_TIMEOUT_MS' | 'PAYMENTS_SERVICE_URL' | 'PAYMENTS_REQUEST_TIMEOUT_MS'>>;

export interface GatewaySearchOptions {enabled:boolean;url:string;timeoutMs:number}
export function createApp(options: GatewayOptions = loadGatewayEnvironment({}), protection?: ProtectionOptions, search?: GatewaySearchOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', protection ? createProxyTrust(protection.trustedProxies) : false);
  app.use((_req, res, next) => { res.locals.requestId = randomUUID(); res.set('X-Request-Id', res.locals.requestId); next(); });
  const metrics = protection ? protection.metrics ?? new RateLimitMetrics() : undefined;
  app.locals.rateLimitMetrics = metrics;
  const guard: RequestHandler = protection ? rateLimitMiddleware({ ...protection, metrics: metrics! }) : (_req, _res, next) => next();
  app.get('/ready', (_req, res) => {
    const ready = !protection || protection.limiter.store.ready;
    res.status(ready ? 200 : 503).json({ rateLimiting: !protection ? 'disabled' : ready ? 'ready' : 'degraded' });
  });

  app.get('/health', (_request, response) => {
    const body: HealthResponse = { status: 'ok', service: 'api-gateway' };
    response.status(200).json(body);
  });

  const upstreams = {
    Payments: { url: options.PAYMENTS_SERVICE_URL ?? 'http://127.0.0.1:4004', timeout: options.PAYMENTS_REQUEST_TIMEOUT_MS ?? 10000 },
    Inventory: { url: options.INVENTORY_SERVICE_URL ?? 'http://127.0.0.1:4005', timeout: options.INVENTORY_REQUEST_TIMEOUT_MS ?? 10000 },
    Catalog: { url: options.CATALOG_SERVICE_URL, timeout: options.CATALOG_REQUEST_TIMEOUT_MS },
    Auth: { url: options.AUTH_SERVICE_URL ?? 'http://127.0.0.1:4000', timeout: options.AUTH_REQUEST_TIMEOUT_MS ?? 3000 },
    Orders: { url: options.ORDERS_SERVICE_URL ?? 'http://127.0.0.1:4003', timeout: options.ORDERS_REQUEST_TIMEOUT_MS ?? 10000 },
    Cart: { url: options.CART_SERVICE_URL ?? 'http://127.0.0.1:4002', timeout: options.CART_REQUEST_TIMEOUT_MS ?? 3000 },
  };
  const forward = (service: keyof typeof upstreams): RequestHandler<{ id?: string; productId?: string }> => async (request, response) => {
    const id = request.params.id;
    const productId = request.params.productId;
    let path = service === 'Catalog'
      ? id === undefined ? '/products' : `/products/${encodeURIComponent(id)}`
      : service === 'Orders' ? id === undefined ? '/orders' : `/orders/${encodeURIComponent(id)}`
      : service === 'Cart' && productId !== undefined ? `/cart/items/${encodeURIComponent(productId)}` : request.path;
    if(service==='Orders')path=request.path;
    if (service === 'Orders') {
      const queryIndex = request.originalUrl.indexOf('?');
      if (queryIndex !== -1) path += request.originalUrl.slice(queryIndex);
    }
    const upstream = await requestUpstream(
      upstreams[service].url, path, upstreams[service].timeout,
      {
        method: request.method,
        ...(typeof request.headers['idempotency-key'] === 'string' ? { idempotencyKey: request.headers['idempotency-key'] } : {}),
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(Buffer.isBuffer(request.body) ? { body: request.body.toString('utf8') } : {}),
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
      }, service,
    );
    response.status(upstream.status);
    if (upstream.cacheControl) response.set('cache-control', upstream.cacheControl);
    if (upstream.wwwAuthenticate) response.set('www-authenticate', upstream.wwwAuthenticate);
    if (upstream.location) response.set('location', upstream.location);
    if (upstream.status === 204) { response.end(); return; }
    response.set('content-type', upstream.contentType).send(upstream.body);
  };
  if(search?.enabled)app.get('/search/products',guard,async(req,res)=>{
    // Preserve validated query bytes; never forward arbitrary paths/internal export routes.
    const result=await requestUpstream(search.url,req.originalUrl,search.timeoutMs,{method:req.method},'Search');
    res.status(result.status).set('Content-Type',result.contentType).set('Cache-Control','no-store').send(result.body);
  });
  app.get<{ id?: string }>(['/products', '/products/:id'], guard, forward('Catalog'));
  // Forward JSON bytes without parsing or duplicating Catalog validation.
  const body = express.raw({ type: () => true, limit: '100kb' });
  app.post('/products', guard, body, forward('Catalog'));
  app.patch('/products/:id', guard, body, forward('Catalog'));
  app.delete('/products/:id', guard, body, forward('Catalog'));

  app.post(['/auth/register', '/auth/login'], guard, body, forward('Auth'));
  app.get('/auth/me', guard, forward('Auth'));

  app.post(['/checkout','/checkout/:orderId/retry'], guard, body, forward('Orders'));
  app.get('/checkout/:orderId/status', guard, forward('Orders'));
  app.post('/orders/:orderId/cancel', guard, body, forward('Orders'));
  app.get(['/orders/:orderId/cancellation','/orders/:orderId/refunds'], guard, forward('Orders'));
  app.post('/payments/:paymentId/refunds', guard, body, forward('Payments'));
  app.get(['/payments/:paymentId/refunds','/payments/refunds/:refundId'], guard, forward('Payments'));
  app.post('/payments/refunds/:refundId/reconcile', guard, body, forward('Payments'));
  app.post('/orders', guard, body, forward('Orders'));
  app.get(['/orders', '/orders/:id'], guard, forward('Orders'));

  app.get('/payments/:paymentId', guard, forward('Payments'));
  app.post(['/payments/intents', '/payments/:paymentId/process', '/payments/:paymentId/reconcile'], guard, body, forward('Payments'));

  app.get('/inventory/:productId', guard, forward('Inventory'));
  app.put('/inventory/:productId', guard, body, forward('Inventory'));
  app.post(['/inventory/reservations', '/inventory/reservations/:orderId/confirm', '/inventory/reservations/:orderId/release'], guard, body, forward('Inventory'));

  app.get('/cart', guard, forward('Cart'));
  app.post('/cart/items', guard, body, forward('Cart'));
  app.patch('/cart/items/:productId', guard, body, forward('Cart'));
  app.delete(['/cart', '/cart/items/:productId'], guard, body, forward('Cart'));

  app.use((_request, response) => {
    const body: ErrorResponse = { error: { message: 'Route not found' } };
    response.status(404).json(body);
  });
  app.use(errorHandler);
  return app;
}
