import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJwtFixture } from '../../../test/jwt-fixture.js';
import { createApp } from '../src/app.js';
import { CartRepository } from '../src/cart-repository.js';
import { CartService } from '../src/cart-service.js';
import { CatalogClient } from '../src/catalog-client.js';
import { createRedisClient, connectRedis } from '../src/redis/client.js';

if (existsSync('.env.cart')) loadEnvFile('.env.cart');
const testUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ['redis:', 'rediss:'].includes(url.protocol) && url.pathname === '/15' && !url.search && !url.hash;
}, 'Tests require Redis database 15').parse(process.env.CART_TEST_REDIS_URL);
// Never use the development Redis URL; never FLUSHDB/FLUSHALL or remove foreign keys.
const client = createRedisClient(testUrl);
const prefix = `test:${randomUUID()}:cart:`;
const ttlSeconds = 604800;
const carts = new CartRepository(client, ttlSeconds, 1000, prefix);
const firstUser = randomUUID();
const secondUser = randomUUID();
const productId = '11111111-1111-4111-8111-111111111111';
const otherProductId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const missingProductId = '33333333-3333-4333-8333-333333333333';
const jwt = await createJwtFixture();
const firstHeader = `Bearer ${await jwt.sign('customer', { sub: firstUser })}`;
const secondHeader = `Bearer ${await jwt.sign('customer', { sub: secondUser })}`;
let catalogMode: 'ok' | 'error' | 'slow' = 'ok';
const catalogRequests: string[] = [];
const catalog = createServer((req, res) => {
  catalogRequests.push(`${req.method} ${req.url}`);
  if (catalogMode === 'slow') return;
  if (catalogMode === 'error') { res.writeHead(500).end('internal details'); return; }
  const exists = req.url === `/products/${productId}` || req.url === `/products/${otherProductId}`;
  res.writeHead(exists ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(exists ? { id: req.url?.split('/').pop() } : { error: { message: 'Product not found' } }));
});
let app: ReturnType<typeof createApp>;
let catalogUrl: string;

beforeAll(async () => {
  await connectRedis(client, 2000);
  await new Promise<void>((resolve, reject) => {
    catalog.once('error', reject); catalog.listen(0, '127.0.0.1', resolve);
  });
  catalogUrl = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  app = createApp(new CartService(carts, new CatalogClient(catalogUrl, 1000)), jwt.verify);
});
beforeEach(async () => {
  await client.del([carts.key(firstUser), carts.key(secondUser)]);
  catalogMode = 'ok'; catalogRequests.length = 0;
});
afterAll(async () => {
  if (client.isReady) await client.del([carts.key(firstUser), carts.key(secondUser)]);
  client.destroy();
  if (catalog.listening) await new Promise<void>((resolve) => {
    catalog.close(() => resolve()); catalog.closeAllConnections();
  });
});
const add = (quantity: number, id = productId, header = firstHeader) =>
  request(app).post('/cart/items').set('authorization', header).send({ productId: id, quantity });
const read = (header = firstHeader) => request(app).get('/cart').set('authorization', header);

describe('Cart authentication and isolation', () => {
  it('reports process health', async () => {
    expect((await request(app).get('/health').expect(200)).body).toEqual({ status: 'ok', service: 'cart-service' });
  });
  it.each([
    ['get', '/cart'], ['post', '/cart/items'], ['patch', `/cart/items/${productId}`],
    ['delete', `/cart/items/${productId}`], ['delete', '/cart'],
  ] as const)('requires authentication for %s %s', async (method, path) => {
    const response = await request(app)[method](path).expect(401);
    expect(response.body).toEqual({ error: { message: 'Unauthorized' } });
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('rejects invalid, expired, wrong-issuer/audience/subject and wrong-signature JWTs', async () => {
    const other = await createJwtFixture();
    for (const token of [
      'invalid', await jwt.sign('customer', { sub: firstUser, exp: 1 }),
      await jwt.sign('customer', { sub: firstUser, iss: 'wrong' }),
      await jwt.sign('customer', { sub: firstUser, aud: 'wrong' }),
      await jwt.sign('customer', { sub: 'invalid-id' }), await other.sign('customer', { sub: firstUser }),
    ]) await read(`Bearer ${token}`).expect(401);
  });
  it('returns an empty cart for a valid customer JWT', async () => {
    const response = await read().expect(200);
    expect(response.body).toEqual({ items: [] });
  });
  it('isolates users and ignores supplied owner headers', async () => {
    await add(2).expect(200);
    const second = await read(secondHeader).set('x-user-id', firstUser).expect(200);
    expect(second.body).toEqual({ items: [] });
    await request(app).patch(`/cart/items/${productId}`).set('authorization', secondHeader).send({ quantity: 3 }).expect(404);
    await request(app).delete(`/cart/items/${productId}`).set('authorization', secondHeader).expect(404);
    await request(app).delete('/cart').set('authorization', secondHeader).expect(204);
    await request(app).post('/cart/items').set('authorization', secondHeader)
      .send({ productId, quantity: 1, userId: firstUser }).expect(400);
    expect((await read()).body).toEqual({ items: [{ productId, quantity: 2 }] });
  });
});

describe('Cart items with real Redis and Catalog HTTP', () => {
  it('adds an item and increments it on subsequent additions', async () => {
    expect((await add(2).expect(200)).body).toEqual({ items: [{ productId, quantity: 2 }] });
    expect((await add(3).expect(200)).body).toEqual({ items: [{ productId, quantity: 5 }] });
    expect(catalogRequests).toEqual([`GET /products/${productId}`, `GET /products/${productId}`]);
    expect(await client.hGetAll(carts.key(firstUser))).toEqual({ [productId]: '5' });
  });
  it.each([0, -1, 100, 1.5, '2', null, true])('rejects invalid add quantity %j', async (quantity) => {
    await request(app).post('/cart/items').set('authorization', firstHeader).send({ productId, quantity }).expect(400);
    expect((await read()).body).toEqual({ items: [] });
    expect(catalogRequests).toEqual([]);
  });
  it('rejects invalid UUIDs, missing fields, unknown fields and malformed JSON', async () => {
    for (const body of [{ productId: 'invalid', quantity: 1 }, { productId }, { quantity: 1 }, { productId, quantity: 1, priceInPaise: 10 }]) {
      await request(app).post('/cart/items').set('authorization', firstHeader).send(body).expect(400);
    }
    await request(app).post('/cart/items').set('authorization', firstHeader).set('content-type', 'application/json').send('{broken').expect(400);
    await request(app).patch('/cart/items/invalid').set('authorization', firstHeader).send({ quantity: 2 }).expect(400);
    await request(app).delete('/cart/items/invalid').set('authorization', firstHeader).expect(400);
  });
  it('rejects nonexistent Catalog products without creating cart state', async () => {
    const response = await add(1, missingProductId).expect(404);
    expect(response.body).toEqual({ error: { message: 'Product not found' } });
    expect(await client.exists(carts.key(firstUser))).toBe(0);
  });
  it('enforces the maximum after incrementing without changing the stored quantity', async () => {
    await add(99).expect(200);
    await add(1).expect(400);
    expect((await read()).body).toEqual({ items: [{ productId, quantity: 99 }] });
  });
  it('canonicalizes UUID case for product fields and verified owners', async () => {
    await add(2, otherProductId.toUpperCase()).expect(200);
    const upperOwner = `Bearer ${await jwt.sign('customer', { sub: firstUser.toUpperCase() })}`;
    await add(3, otherProductId, upperOwner).expect(200);
    expect((await read()).body).toEqual({ items: [{ productId: otherProductId, quantity: 5 }] });
  });
  it('sets quantity while preserving other cart items', async () => {
    await add(2).expect(200); await add(4, otherProductId).expect(200);
    const response = await request(app).patch(`/cart/items/${productId}`).set('authorization', firstHeader).send({ quantity: 3 }).expect(200);
    expect(response.body).toEqual({ items: [{ productId, quantity: 3 }, { productId: otherProductId, quantity: 4 }] });
  });
  it.each([{}, { quantity: 0 }, { quantity: 100 }, { quantity: '3' }, { quantity: 1.5 }, { quantity: 3, userId: secondUser }])
    ('rejects invalid PATCH body %j', async (body) => {
      await add(2).expect(200);
      await request(app).patch(`/cart/items/${productId}`).set('authorization', firstHeader).send(body).expect(400);
      expect((await read()).body).toEqual({ items: [{ productId, quantity: 2 }] });
    });
  it('does not create an absent item through PATCH', async () => {
    await request(app).patch(`/cart/items/${productId}`).set('authorization', firstHeader).send({ quantity: 2 }).expect(404);
    expect(await client.exists(carts.key(firstUser))).toBe(0);
  });
  it('removes items with an empty 204 response and returns 404 for absent items', async () => {
    await add(2).expect(200);
    const response = await request(app).delete(`/cart/items/${productId}`).set('authorization', firstHeader).expect(204);
    expect(response.text).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
    expect((await read()).body).toEqual({ items: [] });
    expect(await client.ttl(carts.key(firstUser))).toBe(-2);
    await request(app).delete(`/cart/items/${productId}`).set('authorization', firstHeader).expect(404);
  });
  it('clears a populated cart and safely clears it again', async () => {
    await add(2).expect(200);
    for (let i = 0; i < 2; i++) {
      const response = await request(app).delete('/cart').set('authorization', firstHeader).expect(204);
      expect(response.text).toBe('');
    }
    expect((await read()).body).toEqual({ items: [] });
  });
  it('does not lose updates under concurrent additions', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => add(1)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await read()).body).toEqual({ items: [{ productId, quantity: 20 }] });
  });
  it('never exceeds the maximum under concurrent additions', async () => {
    await add(90).expect(200);
    const responses = await Promise.all(Array.from({ length: 25 }, () => add(1)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(9);
    expect(responses.filter((response) => response.status === 400)).toHaveLength(16);
    expect((await read()).body).toEqual({ items: [{ productId, quantity: 99 }] });
  });
});

describe('TTL and safe dependency failures', () => {
  it('sets seven-day TTL, refreshes it on successful mutations, and leaves reads/failures unchanged', async () => {
    await add(2).expect(200);
    const key = carts.key(firstUser);
    expect(await client.ttl(key)).toBeGreaterThanOrEqual(ttlSeconds - 2);
    await client.expire(key, 10);
    await read().expect(200);
    expect(await client.ttl(key)).toBeLessThanOrEqual(10);
    await add(1).expect(200);
    expect(await client.ttl(key)).toBeGreaterThanOrEqual(ttlSeconds - 2);
    await client.expire(key, 10);
    await request(app).patch(`/cart/items/${productId}`).set('authorization', firstHeader).send({ quantity: 99 }).expect(200);
    expect(await client.ttl(key)).toBeGreaterThanOrEqual(ttlSeconds - 2);
    await client.expire(key, 10);
    await add(1).expect(400);
    expect(await client.ttl(key)).toBeLessThanOrEqual(10);
    await add(1, otherProductId).expect(200);
    await client.expire(key, 10);
    await request(app).delete(`/cart/items/${otherProductId}`).set('authorization', firstHeader).expect(204);
    expect(await client.ttl(key)).toBeGreaterThanOrEqual(ttlSeconds - 2);
  });
  it('expires carts after the configured TTL', async () => {
    const short = new CartRepository(client, 1, 1000, prefix);
    await short.add(firstUser, productId, 1);
    await delay(1100);
    expect(await short.find(firstUser)).toEqual({ items: [] });
    expect(await client.exists(short.key(firstUser))).toBe(0);
  });
  it('returns 503 rather than an empty cart when Redis is disconnected', async () => {
    const disconnected = createRedisClient(testUrl);
    await connectRedis(disconnected, 2000); disconnected.destroy();
    const offline = createApp(new CartService(new CartRepository(disconnected, ttlSeconds), new CatalogClient(catalogUrl, 1000)), jwt.verify);
    const response = await request(offline).get('/cart').set('authorization', firstHeader).expect(503);
    expect(response.body).toEqual({ error: { message: 'Cart storage unavailable' } });
    await request(offline).post('/cart/items').set('authorization', firstHeader).send({ productId, quantity: 1 }).expect(503);
  });
  it('rejects corrupted storage rather than presenting an empty cart', async () => {
    await client.hSet(carts.key(firstUser), productId, 'invalid');
    await read().expect(503);
  });
  it('returns 502 for Catalog server errors without mutating the cart', async () => {
    catalogMode = 'error';
    const response = await add(1).expect(502);
    expect(response.body).toEqual({ error: { message: 'Catalog Service unavailable' } });
    expect((await read()).body).toEqual({ items: [] });
  });
  it('returns 502 for an unavailable Catalog connection', async () => {
    const temporary = createServer();
    await new Promise<void>((resolve) => temporary.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(temporary.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => temporary.close(() => resolve()));
    const unavailable = createApp(new CartService(carts, new CatalogClient(url, 1000)), jwt.verify);
    await request(unavailable).post('/cart/items').set('authorization', firstHeader).send({ productId, quantity: 1 }).expect(502);
    expect(await client.exists(carts.key(firstUser))).toBe(0);
  });
  it('returns 504 for Catalog timeout without mutating the cart', async () => {
    catalogMode = 'slow';
    const slow = createApp(new CartService(carts, new CatalogClient(catalogUrl, 50)), jwt.verify);
    const response = await request(slow).post('/cart/items').set('authorization', firstHeader).send({ productId, quantity: 1 }).expect(504);
    expect(response.body).toEqual({ error: { message: 'Catalog Service request timed out' } });
    expect(await client.exists(carts.key(firstUser))).toBe(0);
  });
  it('bounds initial Redis connection attempts', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const temporary = createServer();
    await new Promise<void>((resolve) => temporary.listen(0, '127.0.0.1', resolve));
    const url = `redis://127.0.0.1:${(temporary.address() as AddressInfo).port}/15`;
    await new Promise<void>((resolve) => temporary.close(() => resolve()));
    const unavailable = createRedisClient(url, 50);
    try { await expect(connectRedis(unavailable, 50)).rejects.toThrow('Cart Redis connection failed'); }
    finally { unavailable.destroy(); log.mockRestore(); }
  });
});
