import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp as createCatalogApp } from '../../catalog-service/src/app.js';
import { createApp } from '../src/app.js';

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function gateway(url: string, timeout = 1000) {
  return createApp({ CATALOG_SERVICE_URL: url, CATALOG_REQUEST_TIMEOUT_MS: timeout });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe('Gateway product forwarding over HTTP', () => {
  it('forwards listing and lookup to Catalog and preserves missing-product responses', async () => {
    const product = {
      id: '11111111-1111-4111-8111-111111111111', name: 'Notebook',
      description: 'A ruled paper notebook.', priceInPaise: 14900,
    };
    const catalog = createCatalogApp({
      create: async () => { throw new Error('Unused by GET fixture'); },
      update: async () => { throw new Error('Unused by GET fixture'); },
      delete: async () => { throw new Error('Unused by GET fixture'); },
      findAll: async () => [product],
      findById: async (id) => id === product.id ? product : undefined,
    }, async () => { throw new Error('GET fixture does not authenticate'); });
    const url = await listen(createServer(catalog));
    const app = gateway(url);
    for (const path of ['/products', `/products/${product.id}`, '/products/44444444-4444-4444-8444-444444444444']) {
      const expected = await request(catalog).get(path);
      const actual = await request(app).get(path);
      expect(actual.status).toBe(expected.status);
      expect(actual.body).toEqual(expected.body);
      expect(actual.headers['content-type']).toBe(expected.headers['content-type']);
    }
  });

  it('returns 502 when Catalog is unavailable and keeps gateway health working', async () => {
    const server = createServer();
    const url = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    const app = gateway(url);
    const response = await request(app).get('/products').expect(502);
    expect(response.body).toEqual({ error: { message: 'Catalog Service unavailable' } });
    await request(app).get('/health').expect(200);
    const missing = await request(app).get('/unknown').expect(404);
    expect(missing.body).toEqual({ error: { message: 'Route not found' } });
  });

  it('returns 502 when Catalog reports a server error', async () => {
    const url = await listen(createServer((_req, res) => res.writeHead(500).end('internal details')));
    const response = await request(gateway(url)).get('/products/1').expect(502);
    expect(response.body).toEqual({ error: { message: 'Catalog Service unavailable' } });
  });

  it('returns 504 when Catalog does not respond', async () => {
    const url = await listen(createServer(() => {}));
    const response = await request(gateway(url, 50)).get('/products').expect(504);
    expect(response.body).toEqual({ error: { message: 'Catalog Service request timed out' } });
  });

  it('keeps the timeout active while reading the response body', async () => {
    const url = await listen(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('[');
    }));
    const response = await request(gateway(url, 50)).get('/products').expect(504);
    expect(response.body).toEqual({ error: { message: 'Catalog Service request timed out' } });
  });
});

describe('Gateway product management forwarding', () => {
  it.each([
    ['post', '/products', 201],
    ['patch', '/products/11111111-1111-4111-8111-111111111111', 200],
    ['delete', '/products/11111111-1111-4111-8111-111111111111', 204],
  ] as const)('forwards %s method, body, status and relevant headers', async (method, path, status) => {
    const rawBody = '{ "name": "  Keyboard  ", "description": "Wireless", "priceInPaise": 499900 }';
    let seen: { method?: string; path?: string; body: string; contentType?: string } | undefined;
    const location = '/products/11111111-1111-4111-8111-111111111111';
    const url = await listen(createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seen = { method: req.method!, path: req.url!, body: Buffer.concat(chunks).toString(), contentType: req.headers['content-type']! };
      res.writeHead(status, status === 204 ? {} : { 'content-type': 'application/json', location });
      res.end(status === 204 ? undefined : JSON.stringify({ id: location.split('/').pop() }));
    }));
    const response = await request(gateway(url))[method](path).set('content-type', 'application/json').send(rawBody).expect(status);
    expect(seen).toEqual({ method: method.toUpperCase(), path, body: rawBody, contentType: 'application/json' });
    if (status === 204) {
      expect(response.text).toBe('');
      expect(response.headers['content-type']).toBeUndefined();
    } else {
      expect(response.headers.location).toBe(location);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toEqual({ id: location.split('/').pop() });
    }
  });

  it.each([400, 404])('preserves upstream %i responses', async (status) => {
    const url = await listen(createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Catalog validation response' } }));
    }));
    const response = await request(gateway(url)).patch('/products/invalid').send({ arbitrary: true }).expect(status);
    expect(response.body).toEqual({ error: { message: 'Catalog validation response' } });
  });

  it('forwards malformed JSON for Catalog to validate', async () => {
    let body = '';
    const url = await listen(createServer(async (req, res) => {
      for await (const chunk of req) body += chunk.toString();
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Invalid JSON body"}}');
    }));
    const response = await request(gateway(url)).post('/products').set('content-type', 'application/json').send('{broken').expect(400);
    expect(body).toBe('{broken');
    expect(response.body).toEqual({ error: { message: 'Invalid JSON body' } });
  });

  it.each(['post', 'patch', 'delete'] as const)('keeps 502/504 behavior for %s', async (method) => {
    const path = method === 'post' ? '/products' : '/products/11111111-1111-4111-8111-111111111111';
    const unavailable = createServer();
    const unavailableUrl = await listen(unavailable);
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    servers.splice(servers.indexOf(unavailable), 1);
    const failed = await request(gateway(unavailableUrl))[method](path).send({ name: 'Test' }).expect(502);
    expect(failed.body).toEqual({ error: { message: 'Catalog Service unavailable' } });
    const slowUrl = await listen(createServer(() => {}));
    const timedOut = await request(gateway(slowUrl, 50))[method](path).send({ name: 'Test' }).expect(504);
    expect(timedOut.body).toEqual({ error: { message: 'Catalog Service request timed out' } });
  });
});
