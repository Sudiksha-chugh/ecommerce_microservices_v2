import {testEnvironmentFile} from '../../../test/environment.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { z } from 'zod';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJwtFixture } from '../../../test/jwt-fixture.js';
import { createApp } from '../src/app.js';
import { OrderRepository, type CheckoutSnapshot } from '../src/order-repository.js';
import { OrderService } from '../src/order-service.js';
import { CartClient, CatalogClient } from '../src/http-clients.js';
import { migrate } from '../src/db/migrate.js';

if (existsSync(testEnvironmentFile('.env.orders'))) loadEnvFile(testEnvironmentFile('.env.orders'));
const environment = z.object({
  ORDERS_PGHOST: z.string().min(1).default('127.0.0.1'),
  ORDERS_PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  ORDERS_TEST_PASSWORD: z.string().min(1),
}).parse(process.env);
const config = {
  host: environment.ORDERS_PGHOST, port: environment.ORDERS_PGPORT,
  database: 'orders_test_db', user: 'orders_test_user', password: environment.ORDERS_TEST_PASSWORD,
  max: 5, connectionTimeoutMillis: 2000, statement_timeout: 2000,
};
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool(config);
const pool = new Pool({ ...config, options: `-c search_path=${schema}` });
const repository = new OrderRepository(pool);
const userId = randomUUID(); const otherUserId = randomUUID();
const productId = '11111111-1111-4111-8111-111111111111';
const secondProductId = '22222222-2222-4222-8222-222222222222';
const jwt = await createJwtFixture();
const authorization = `Bearer ${await jwt.sign('customer', { sub: userId })}`;
const otherAuthorization = `Bearer ${await jwt.sign('customer', { sub: otherUserId })}`;
const servers: Server[] = [];
let carts = new Map<string, { items: Array<{ productId: string; quantity: number }> }>();
let products = new Map<string, { id: string; name: string; priceInPaise: number }>();
let cartMode = 'normal'; let catalogMode = 'normal';
let cartHeaders: string[] = []; let cartMethods: string[] = [];
let catalogRequests: string[] = [];
let gate: Array<() => void> = [];
let app: ReturnType<typeof createApp>;
let cartUrl: string; let catalogUrl: string;
let schemaCreated = false;
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const application = (cartOrigin = cartUrl, catalogOrigin = catalogUrl, cartTimeout = 1000, catalogTimeout = 1000) =>
  createApp(new OrderService(repository, new CartClient(cartOrigin, cartTimeout), new CatalogClient(catalogOrigin, catalogTimeout)), jwt.verify);
const create = (key = 'checkout-1', header = authorization, body: object = {}) =>
  request(app).post('/orders').set('authorization', header).set('idempotency-key', key).send(body);
const counts = async () => ({
  orders: (await pool.query('SELECT * FROM orders')).rowCount,
  items: (await pool.query('SELECT * FROM order_items')).rowCount,
});

beforeAll(async () => {
  const identity = await admin.query('SELECT current_database() AS db, current_user AS role');
  expect(identity.rows[0]).toEqual({ db: 'orders_test_db', role: 'orders_test_user' });
  await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
  await migrate(pool);
  cartUrl = await listen(createServer(async (req, res) => {
    cartHeaders.push(req.headers.authorization ?? ''); cartMethods.push(req.method ?? '');
    if (cartMode === 'slow') return;
    if (cartMode === 'error') { res.writeHead(503).end('internal details'); return; }
    const identity = await jwt.verify(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    if (cartMode === 'invalid') { res.end('{"items":[{"productId":"invalid","quantity":0}]}'); return; }
    if (cartMode === 'conflict') {
      const quantity = gate.length + 1;
      gate.push(() => res.end(JSON.stringify({ items: [{ productId, quantity }] })));
      if (gate.length === 2) { const ready = gate; gate = []; ready.forEach((reply) => reply()); }
      return;
    }
    res.end(JSON.stringify(carts.get(identity.id) ?? { items: [] }));
  }));
  catalogUrl = await listen(createServer((req, res) => {
    catalogRequests.push(req.url ?? '');
    if (catalogMode === 'slow') return;
    if (catalogMode === 'body-slow') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    if (catalogMode === 'error') { res.writeHead(500).end('internal details'); return; }
    if (catalogMode === 'invalid') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"invalid"}'); return; }
    const product = products.get(req.url?.split('/').pop() ?? '');
    res.writeHead(product ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(product ?? { error: { message: 'Product not found' } }));
  }));
  app = application();
});
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await pool.query('TRUNCATE orders CASCADE');
  carts = new Map([[userId, { items: [{ productId, quantity: 2 }] }]]);
  products = new Map([
    [productId, { id: productId, name: 'Notebook', priceInPaise: 14900 }],
    [secondProductId, { id: secondProductId, name: 'Coffee mug', priceInPaise: 29900 }],
  ]);
  cartMode = 'normal'; catalogMode = 'normal'; cartHeaders = []; cartMethods = []; catalogRequests = []; gate = [];
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await pool.end();
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
});

describe('Orders authentication and inputs', () => {
  it('reports process health', async () => {
    expect((await request(app).get('/health').expect(200)).body).toEqual({ status: 'ok', service: 'orders-service' });
  });
  it.each([['post', '/orders'], ['get', '/orders'], ['get', `/orders/${randomUUID()}`]] as const)('requires JWT for %s %s', async (method, path) => {
    await request(app)[method](path).expect(401);
  });
  it('rejects malformed, expired, wrong-signature and wrong-claim tokens', async () => {
    const other = await createJwtFixture();
    for (const token of ['invalid', await jwt.sign('customer', { sub: userId, exp: 1 }),
      await other.sign('customer', { sub: userId }), await jwt.sign('customer', { sub: userId, iss: 'wrong' }),
      await jwt.sign('customer', { sub: userId, aud: 'wrong' }), await jwt.sign('customer', { sub: 'invalid' }),
    ]) await create('key', `Bearer ${token}`).expect(401);
    expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it.each(['', 'space key', 'key,key', 'x'.repeat(256), 'bad/key'])('rejects invalid Idempotency-Key %j', async (key) => {
    await create(key).expect(400);
  });
  it('requires Idempotency-Key', async () => {
    await request(app).post('/orders').set('authorization', authorization).expect(400);
  });
  it.each([{ userId: otherUserId }, { user_id: otherUserId }, { totalAmountInPaise: 1 }, { items: [] }, { priceInPaise: 1 }])
    ('rejects client-controlled checkout input %j', async (body) => {
      await create('key', authorization, body).expect(400);
      expect(await counts()).toEqual({ orders: 0, items: 0 });
    });
  it('accepts an omitted request body and rejects malformed JSON', async () => {
    await request(app).post('/orders').set('authorization', authorization).set('idempotency-key', 'no-body').expect(201);
    await request(app).post('/orders').set('authorization', authorization).set('idempotency-key', 'bad-body')
      .set('content-type', 'application/json').send('{broken').expect(400);
  });
  it.each(['text/plain', 'application/octet-stream'])('rejects non-JSON checkout bodies with %s', async (contentType) => {
    await request(app).post('/orders').set('authorization', authorization).set('idempotency-key', 'non-json')
      .set('content-type', contentType).send('{"totalAmountInPaise":1}').expect(400);
    expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
});

describe('Authoritative order snapshots and exact money', () => {
  it('creates a PENDING order, forwards the JWT, and leaves the cart unchanged', async () => {
    const before = structuredClone(carts.get(userId));
    const response = await create().expect(201);
    expect(z.uuid().safeParse(response.body.id).success).toBe(true);
    expect(response.headers.location).toBe(`/orders/${response.body.id}`);
    expect(response.body).toMatchObject({ userId, status: 'PENDING', totalAmountInPaise: 29800,
      items: [{ productId, productName: 'Notebook', unitPriceInPaise: 14900, quantity: 2, lineTotalInPaise: 29800 }] });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toHaveProperty('request_fingerprint');
    expect(cartHeaders).toEqual([authorization]); expect(cartMethods).toEqual(['GET']);
    expect(carts.get(userId)).toEqual(before);
    expect(await counts()).toEqual({ orders: 1, items: 1 });
    const outbox = await pool.query('SELECT * FROM outbox_events WHERE aggregate_id=$1', [response.body.id]);
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].envelope.payload.totalAmountPaise).toBe(response.body.totalAmountInPaise);
  });
  it('creates multiple items with correct totals and deterministic snapshot ordering', async () => {
    carts.set(userId, { items: [{ productId: secondProductId, quantity: 3 }, { productId, quantity: 2 }] });
    const response = await create().expect(201);
    expect(response.body.totalAmountInPaise).toBe(119500);
    expect(response.body.items).toEqual([
      { productId, productName: 'Notebook', unitPriceInPaise: 14900, quantity: 2, lineTotalInPaise: 29800 },
      { productId: secondProductId, productName: 'Coffee mug', unitPriceInPaise: 29900, quantity: 3, lineTotalInPaise: 89700 },
    ]);
    expect(await counts()).toEqual({ orders: 1, items: 2 });
  });
  it('preserves historical names and prices after Catalog changes', async () => {
    const created = await create().expect(201);
    products.set(productId, { id: productId, name: 'New name', priceInPaise: 99900 });
    const retrieved = await request(app).get(`/orders/${created.body.id}`).set('authorization', authorization).expect(200);
    expect(retrieved.body).toEqual(created.body);
  });
  it('rejects an empty cart', async () => {
    carts.set(userId, { items: [] });
    await create().expect(422); expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it('rejects a missing product without persisting an order', async () => {
    products.delete(productId);
    await create().expect(422); expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it('rejects unsupported cart size and duplicate product IDs', async () => {
    carts.set(userId, { items: Array.from({ length: 101 }, () => ({ productId: randomUUID(), quantity: 1 })) });
    await create().expect(422);
    carts.set(userId, { items: [{ productId, quantity: 1 }, { productId, quantity: 2 }] });
    await create().expect(502); expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it('supports zero and maximum-safe integer amounts without precision loss', async () => {
    carts.set(userId, { items: [{ productId, quantity: 1 }] });
    for (const price of [0, Number.MAX_SAFE_INTEGER]) {
      products.set(productId, { id: productId, name: 'Boundary product', priceInPaise: price });
      const response = await create(`price-${price}`).expect(201);
      expect(response.body.totalAmountInPaise).toBe(price);
      const read = await request(app).get(`/orders/${response.body.id}`).set('authorization', authorization).expect(200);
      expect(read.body).toEqual(response.body);
    }
  });
  it('rejects line-total overflow before persistence', async () => {
    products.set(productId, { id: productId, name: 'Expensive', priceInPaise: Number.MAX_SAFE_INTEGER });
    await create().expect(422); expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it('rejects aggregate overflow even when every line total is supported', async () => {
    const price = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
    carts.set(userId, { items: [{ productId, quantity: 1 }, { productId: secondProductId, quantity: 1 }] });
    products.set(productId, { id: productId, name: 'First', priceInPaise: price });
    products.set(secondProductId, { id: secondProductId, name: 'Second', priceInPaise: price });
    await create().expect(422); expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
});

describe('Idempotency and database uniqueness', () => {
  it('replays the same key without new upstream calls or duplicate rows', async () => {
    const first = await create().expect(201);
    const replay = await create().expect(201);
    expect(replay.body).toEqual(first.body);
    expect(cartHeaders).toHaveLength(1); expect(catalogRequests).toHaveLength(1);
    expect(await counts()).toEqual({ orders: 1, items: 1 });
  });
  it('returns the original order after cart changes and even when dependencies fail', async () => {
    const first = await create().expect(201);
    carts.set(userId, { items: [{ productId: secondProductId, quantity: 9 }] });
    cartMode = 'error'; catalogMode = 'error';
    expect((await create().expect(201)).body).toEqual(first.body);
    expect(cartHeaders).toHaveLength(1);
  });
  it('uses new keys for new orders and scopes keys per user', async () => {
    carts.set(otherUserId, { items: [{ productId, quantity: 1 }] });
    const first = await create('same-key').expect(201);
    const second = await create('different-key').expect(201);
    const other = await create('same-key', otherAuthorization).expect(201);
    expect(new Set([first.body.id, second.body.id, other.body.id]).size).toBe(3);
    expect(other.body.userId).toBe(otherUserId);
    expect(await counts()).toEqual({ orders: 3, items: 3 });
  });
  it('creates one order for concurrent same-key requests', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => create('concurrent-key')));
    expect(responses.every((res) => res.status === 201)).toBe(true);
    expect(new Set(responses.map((res) => res.body.id)).size).toBe(1);
    expect(await counts()).toEqual({ orders: 1, items: 1 });
  });
  it('returns 409 when simultaneous first attempts use different snapshots', async () => {
    cartMode = 'conflict';
    const responses = await Promise.all([create('conflicting-key'), create('conflicting-key')]);
    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(await counts()).toEqual({ orders: 1, items: 1 });
  });
  it('hashes the canonical snapshot independently of cart item ordering', async () => {
    const items = [{ productId, quantity: 1 }, { productId: secondProductId, quantity: 2 }];
    carts.set(userId, { items }); await create('order-a').expect(201);
    carts.set(userId, { items: [...items].reverse() }); await create('order-b').expect(201);
    const result = await pool.query('SELECT request_fingerprint FROM orders');
    expect(result.rows[0].request_fingerprint).toBe(result.rows[1].request_fingerprint);
  });
  it('handles unique-conflict replay with a pool of size one and releases its client', async () => {
    const singlePool = new Pool({ ...config, max: 1, options: `-c search_path=${schema}` });
    const single = new OrderRepository(singlePool);
    const snapshot: CheckoutSnapshot = { totalAmountInPaise: 100, items: [{ productId, productName: 'Test', unitPriceInPaise: 100, quantity: 1, lineTotalInPaise: 100 }] };
    try {
      const first = await single.create(userId, 'single-pool', 'fingerprint', snapshot);
      expect(await single.create(userId, 'single-pool', 'fingerprint', snapshot)).toEqual(first);
      await expect(single.create(userId, 'single-pool', 'different', snapshot)).rejects.toMatchObject({ status: 409 });
      expect(singlePool.waitingCount).toBe(0);
    } finally { await singlePool.end(); }
  });
});

describe('Ownership and bounded order history', () => {
  it('allows owner reads and returns 404 for another user or absent order', async () => {
    const created = await create().expect(201);
    const path = `/orders/${created.body.id}`;
    expect((await request(app).get(path).set('authorization', authorization).expect(200)).body).toEqual(created.body);
    await request(app).get(path).set('authorization', otherAuthorization).set('x-user-id', userId).expect(404);
    await request(app).get(`/orders/${randomUUID()}`).set('authorization', authorization).expect(404);
    await request(app).get('/orders/invalid').set('authorization', authorization).expect(400);
    expect((await request(app).get('/orders').set('authorization', otherAuthorization).expect(200)).body.orders).toEqual([]);
  });
  it('uses verified ownership even when an identity header is forged', async () => {
    const created = await create().set('x-user-id', otherUserId).expect(201);
    expect(created.body.userId).toBe(userId);
  });
  it('defaults to limit 20, offset 0 and orders tied timestamps deterministically', async () => {
    const ids: string[] = [];
    for (const key of ['a', 'b', 'c']) ids.push((await create(key).expect(201)).body.id);
    await pool.query("UPDATE orders SET created_at = '2020-01-01'");
    const response = await request(app).get('/orders').set('authorization', authorization).expect(200);
    expect(response.body.limit).toBe(20); expect(response.body.offset).toBe(0);
    expect(response.body.orders.map((order: { id: string }) => order.id)).toEqual([...ids].sort().reverse());
    const page = await request(app).get('/orders?limit=1&offset=1').set('authorization', authorization).expect(200);
    expect(page.body.orders).toHaveLength(1); expect(page.body.orders[0].id).toBe([...ids].sort().reverse()[1]);
  });
  it.each(['limit=0', 'limit=101', 'limit=1.5', 'limit=abc', 'offset=-1', 'offset=1.5', 'offset=1000001', 'limit=1&limit=2', 'unknown=1'])
    ('rejects invalid pagination %s', async (query) => {
      await request(app).get(`/orders?${query}`).set('authorization', authorization).expect(400);
    });
});

describe('Transactions, database constraints and failures', () => {
  it('rolls back both header and first item when the second item insertion fails', async () => {
    carts.set(userId, { items: [{ productId, quantity: 1 }, { productId: secondProductId, quantity: 1 }] });
    await pool.query(`CREATE FUNCTION reject_second_item() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.product_id = '${secondProductId}'::uuid THEN RAISE EXCEPTION 'test insertion failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION reject_second_item()');
    try {
      const response = await create().expect(500);
      expect(response.body).toEqual({ error: { message: 'Internal server error' } });
      expect(await counts()).toEqual({ orders: 0, items: 0 });
    } finally {
      await pool.query('DROP TRIGGER reject_item ON order_items'); await pool.query('DROP FUNCTION reject_second_item()');
    }
    await create().expect(201); // Failed key was not committed; retry can succeed.
  });
  it('sanitizes database failures', async () => {
    await pool.query('ALTER TABLE orders RENAME TO unavailable_orders');
    try {
      expect((await create().expect(500)).body).toEqual({ error: { message: 'Internal server error' } });
      await request(app).get('/orders').set('authorization', authorization).expect(500);
    } finally { await pool.query('ALTER TABLE unavailable_orders RENAME TO orders'); }
  });
  it('enforces uniqueness, status, money, quantities, item consistency, foreign keys and cascade', async () => {
    const created = await create().expect(201);
    await expect(pool.query("UPDATE orders SET status = 'PAID'")).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE orders SET total_amount_paise = -1')).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE orders SET total_amount_paise = $1', ['9007199254740992'])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE order_items SET quantity = 0')).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE order_items SET unit_price_paise = -1')).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE order_items SET line_total_paise = 1')).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO order_items (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
      VALUES ($1, $2, $3, $4, $5, $6)`, [created.body.id, productId, 'Duplicate', '100', 1, '100'])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`INSERT INTO order_items (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
      VALUES ($1, $2, $3, $4, $5, $6)`, [randomUUID(), productId, 'Orphan', '100', 1, '100'])).rejects.toMatchObject({ code: '23503' });
    await pool.query('DELETE FROM outbox_events WHERE aggregate_id=$1', [created.body.id]);
    await pool.query('DELETE FROM orders WHERE id = $1', [created.body.id]);
    expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it('refuses unsafe stored BIGINTs rather than rounding them', async () => {
    const created = await create().expect(201);
    await pool.query('ALTER TABLE orders DROP CONSTRAINT orders_total_amount_paise_check');
    try {
      await pool.query('UPDATE orders SET total_amount_paise = $1', ['9007199254740992']);
      await request(app).get(`/orders/${created.body.id}`).set('authorization', authorization).expect(500);
    } finally {
      await pool.query('TRUNCATE orders CASCADE');
      await pool.query('ALTER TABLE orders ADD CONSTRAINT orders_total_amount_paise_check CHECK (total_amount_paise BETWEEN 0 AND 9007199254740991)');
    }
  });
  it('runs migrations repeatedly without reapplying them', async () => {
    await migrate(pool); expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(4);
  });
  it.each(['orders_db', 'catalog_db', 'auth_db', 'catalog_test_db', 'auth_test_db'])('test role cannot connect to %s', async (database) => {
    const forbidden = new Pool({ ...config, database });
    try { await expect(forbidden.query('SELECT 1')).rejects.toMatchObject({ code: '42501' }); }
    finally { await forbidden.end(); }
  });
});

describe('Dependency failures do not create orders', () => {
  it.each(['Cart', 'Catalog'])('returns 502 for %s server failure', async (service) => {
    if (service === 'Cart') cartMode = 'error'; else catalogMode = 'error';
    await create().expect(502); expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it.each(['Cart', 'Catalog'])('returns 502 for disconnected %s', async (service) => {
    const temporary = createServer();
    await new Promise<void>((resolve) => temporary.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(temporary.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => temporary.close(() => resolve()));
    const offline = service === 'Cart' ? application(url) : application(cartUrl, url);
    await request(offline).post('/orders').set('authorization', authorization).set('idempotency-key', 'offline').expect(502);
    expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it.each(['Cart', 'Catalog'])('returns 504 for %s timeout', async (service) => {
    if (service === 'Cart') cartMode = 'slow'; else catalogMode = 'slow';
    const slow = application(cartUrl, catalogUrl, service === 'Cart' ? 50 : 1000, service === 'Catalog' ? 50 : 1000);
    await request(slow).post('/orders').set('authorization', authorization).set('idempotency-key', 'timeout').expect(504);
    expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it('keeps the Catalog deadline active through body reading', async () => {
    catalogMode = 'body-slow';
    await request(application(cartUrl, catalogUrl, 1000, 50)).post('/orders')
      .set('authorization', authorization).set('idempotency-key', 'body-timeout').expect(504);
    expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
  it.each(['Cart', 'Catalog'])('rejects malformed %s data', async (service) => {
    if (service === 'Cart') cartMode = 'invalid'; else catalogMode = 'invalid';
    await create().expect(502); expect(await counts()).toEqual({ orders: 0, items: 0 });
  });
});
