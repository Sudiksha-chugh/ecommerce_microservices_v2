import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
const servers: Server[] = [];
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  servers.push(server); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const gateway = (url: string, timeout = 1000) => createApp({
  CATALOG_SERVICE_URL: 'http://127.0.0.1:4001', CATALOG_REQUEST_TIMEOUT_MS: 1000,
  ORDERS_SERVICE_URL: url, ORDERS_REQUEST_TIMEOUT_MS: timeout,
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
});
const id = '11111111-1111-4111-8111-111111111111';
describe('Gateway Orders HTTP forwarding', () => {
  it.each([['post', '/orders', 201], ['get', '/orders?limit=2&offset=1', 200], ['get', `/orders/${id}`, 200]] as const)
    ('forwards %s %s with headers, body, query and status', async (method, path, status) => {
      let seen: { method: string; path: string; authorization: string | undefined; key: string | string[] | undefined; body: string } | undefined;
      const url = await listen(createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk.toString();
        seen = { method: req.method!, path: req.url!, authorization: req.headers.authorization, key: req.headers['idempotency-key'], body };
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', location: `/orders/${id}` });
        res.end(JSON.stringify({ id, status: 'PENDING' }));
      }));
      const call = request(gateway(url))[method](path).set('authorization', 'Bearer orders-token').set('idempotency-key', 'checkout-request-123');
      if (method === 'post') call.set('content-type', 'application/json').send('{ }');
      const response = await call.expect(status);
      expect(seen).toEqual({ method: method.toUpperCase(), path, authorization: 'Bearer orders-token', key: 'checkout-request-123', body: method === 'post' ? '{ }' : '' });
      expect(response.body).toEqual({ id, status: 'PENDING' });
      expect(response.headers.location).toBe(`/orders/${id}`);
      expect(response.headers['cache-control']).toBe('no-store');
    });
  it.each([400, 401, 404, 409, 422, 500, 502, 504])('preserves Orders status %i', async (status) => {
    const url = await listen(createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end('{"error":{"message":"Safe Orders error"}}');
    }));
    const response = await request(gateway(url)).post('/orders').set('idempotency-key', 'key').send({}).expect(status);
    expect(response.body).toEqual({ error: { message: 'Safe Orders error' } });
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });
  it('returns 502 when Orders is disconnected', async () => {
    const server = createServer(); const url = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve())); servers.splice(servers.indexOf(server), 1);
    const response = await request(gateway(url)).post('/orders').send({}).expect(502);
    expect(response.body).toEqual({ error: { message: 'Orders Service unavailable' } });
  });
  it('returns 504 when Orders does not respond', async () => {
    const url = await listen(createServer(() => {}));
    const response = await request(gateway(url, 50)).get('/orders').expect(504);
    expect(response.body).toEqual({ error: { message: 'Orders Service request timed out' } });
  });
});
