import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const servers: Server[] = [];
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function gateway(url: string, timeout = 1000) {
  return createApp({
    CATALOG_SERVICE_URL: 'http://127.0.0.1:4001', CATALOG_REQUEST_TIMEOUT_MS: 1000,
    AUTH_SERVICE_URL: url, AUTH_REQUEST_TIMEOUT_MS: timeout,
  });
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe('Gateway Auth forwarding', () => {
  it.each([
    ['post', '/auth/register', 201], ['post', '/auth/login', 200], ['get', '/auth/me', 200],
  ] as const)('forwards %s %s with method, bytes, Authorization and safe headers', async (method, path, status) => {
    const raw = '{ "email": "user@example.com", "password": "TestPassword123!" }';
    let seen: { method: string; path: string; authorization: string | undefined; body: string } | undefined;
    const url = await listen(createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      seen = { method: req.method!, path: req.url!, authorization: req.headers.authorization, body };
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ forwarded: true }));
    }));
    const call = request(gateway(url))[method](path).set('authorization', 'Bearer test-token');
    if (method === 'post') call.set('content-type', 'application/json').send(raw);
    const response = await call.expect(status);
    expect(seen).toEqual({ method: method.toUpperCase(), path, authorization: 'Bearer test-token', body: method === 'post' ? raw : '' });
    expect(response.body).toEqual({ forwarded: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });
  it.each([400, 401, 409, 500])('preserves Auth status %i and sanitized response', async (status) => {
    const url = await listen(createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'www-authenticate': 'Bearer', 'cache-control': 'no-store' });
      res.end('{"error":{"message":"Safe Auth response"}}');
    }));
    const response = await request(gateway(url)).post('/auth/login').send({ email: 'user@example.com' }).expect(status);
    expect(response.body).toEqual({ error: { message: 'Safe Auth response' } });
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });
  it('returns 502 for unavailable Auth and 504 on timeout', async () => {
    const server = createServer();
    const url = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    const unavailable = await request(gateway(url)).post('/auth/login').send({}).expect(502);
    expect(unavailable.body).toEqual({ error: { message: 'Auth Service unavailable' } });
    const slow = await listen(createServer(() => {}));
    const timeout = await request(gateway(slow, 50)).get('/auth/me').set('authorization', 'Bearer token').expect(504);
    expect(timeout.body).toEqual({ error: { message: 'Auth Service request timed out' } });
  });
  it('forwards Authorization on Catalog writes and preserves 401/403', async () => {
    for (const status of [401, 403]) {
      let authorization: string | undefined;
      const url = await listen(createServer((req, res) => {
        authorization = req.headers.authorization;
        res.writeHead(status, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end('{"error":{"message":"Denied"}}');
      }));
      const app = createApp({ CATALOG_SERVICE_URL: url, CATALOG_REQUEST_TIMEOUT_MS: 1000 });
      await request(app).post('/products').set('authorization', 'Bearer catalog-token').send({ name: 'Test' }).expect(status);
      expect(authorization).toBe('Bearer catalog-token');
    }
  });
});
