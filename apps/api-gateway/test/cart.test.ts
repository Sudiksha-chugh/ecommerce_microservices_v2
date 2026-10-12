import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const servers: Server[] = [];
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const gateway = (url: string, timeout = 1000) => createApp({
  CATALOG_SERVICE_URL: 'http://127.0.0.1:4001', CATALOG_REQUEST_TIMEOUT_MS: 1000,
  CART_SERVICE_URL: url, CART_REQUEST_TIMEOUT_MS: timeout,
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
});
const productId = '11111111-1111-4111-8111-111111111111';

describe('Gateway Cart forwarding', () => {
  it.each([
    ['get', '/cart', 200], ['post', '/cart/items', 200], ['patch', `/cart/items/${productId}`, 200],
    ['delete', `/cart/items/${productId}`, 204], ['delete', '/cart', 204],
  ] as const)('forwards %s %s with method, body, token and status', async (method, path, status) => {
    const raw = `{ "productId": "${productId}", "quantity": 2 }`;
    let seen: { method: string; path: string; authorization: string | undefined; body: string } | undefined;
    const url = await listen(createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      seen = { method: req.method!, path: req.url!, authorization: req.headers.authorization, body };
      res.writeHead(status, status === 204 ? { 'cache-control': 'no-store' } : { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(status === 204 ? undefined : JSON.stringify({ items: [{ productId, quantity: 2 }] }));
    }));
    const call = request(gateway(url))[method](path).set('authorization', 'Bearer cart-token');
    if (method !== 'get') call.set('content-type', 'application/json').send(raw);
    const response = await call.expect(status);
    expect(seen).toEqual({ method: method.toUpperCase(), path, authorization: 'Bearer cart-token', body: method === 'get' ? '' : raw });
    expect(response.headers['cache-control']).toBe('no-store');
    if (status === 204) { expect(response.text).toBe(''); expect(response.headers['content-type']).toBeUndefined(); }
    else expect(response.body).toEqual({ items: [{ productId, quantity: 2 }] });
  });
  it.each([400, 401, 404, 502, 503, 504])('preserves Cart status %i including Redis failure', async (status) => {
    const url = await listen(createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': 'Bearer' });
      res.end('{"error":{"message":"Safe Cart error"}}');
    }));
    const response = await request(gateway(url)).get('/cart').expect(status);
    expect(response.body).toEqual({ error: { message: 'Safe Cart error' } });
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });
  it('returns 502 when Cart is unavailable', async () => {
    const server = createServer(); const url = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    const response = await request(gateway(url)).get('/cart').expect(502);
    expect(response.body).toEqual({ error: { message: 'Cart Service unavailable' } });
  });
  it('returns 504 when Cart does not respond', async () => {
    const url = await listen(createServer(() => {}));
    const response = await request(gateway(url, 50)).get('/cart').expect(504);
    expect(response.body).toEqual({ error: { message: 'Cart Service request timed out' } });
  });
});
