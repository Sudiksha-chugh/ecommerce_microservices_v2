import express, { type RequestHandler } from 'express';
import { loadGatewayEnvironment, type GatewayEnvironment } from '@ecommerce/config';
import { requestUpstream } from './upstream-client.js';
import type { ErrorResponse, HealthResponse } from '@ecommerce/contracts';
import { errorHandler } from './middleware/error-handler.js';

type GatewayOptions = Pick<GatewayEnvironment, 'CATALOG_SERVICE_URL' | 'CATALOG_REQUEST_TIMEOUT_MS'>
  & Partial<Pick<GatewayEnvironment, 'AUTH_SERVICE_URL' | 'AUTH_REQUEST_TIMEOUT_MS' | 'CART_SERVICE_URL' | 'CART_REQUEST_TIMEOUT_MS' | 'ORDERS_SERVICE_URL' | 'ORDERS_REQUEST_TIMEOUT_MS'>>;

export function createApp(options: GatewayOptions = loadGatewayEnvironment({})) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_request, response) => {
    const body: HealthResponse = { status: 'ok', service: 'api-gateway' };
    response.status(200).json(body);
  });

  const upstreams = {
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
  app.get<{ id?: string }>(['/products', '/products/:id'], forward('Catalog'));
  // Forward JSON bytes without parsing or duplicating Catalog validation.
  const body = express.raw({ type: () => true, limit: '100kb' });
  app.post('/products', body, forward('Catalog'));
  app.patch('/products/:id', body, forward('Catalog'));
  app.delete('/products/:id', body, forward('Catalog'));

  app.post(['/auth/register', '/auth/login'], body, forward('Auth'));
  app.get('/auth/me', forward('Auth'));

  app.post('/orders', body, forward('Orders'));
  app.get(['/orders', '/orders/:id'], forward('Orders'));

  app.get('/cart', forward('Cart'));
  app.post('/cart/items', body, forward('Cart'));
  app.patch('/cart/items/:productId', body, forward('Cart'));
  app.delete(['/cart', '/cart/items/:productId'], body, forward('Cart'));

  app.use((_request, response) => {
    const body: ErrorResponse = { error: { message: 'Route not found' } };
    response.status(404).json(body);
  });
  app.use(errorHandler);
  return app;
}
