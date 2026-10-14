import {testEnvironmentFile} from '../../../test/environment.js';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { z } from 'zod';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJwtFixture } from '../../../test/jwt-fixture.js';
import { createApp } from '../src/app.js';
import { InventoryRepository } from '../src/inventory-repository.js';
import { InventoryService } from '../src/inventory-service.js';
import { CatalogClient } from '../src/catalog-client.js';
import { migrate } from '../src/db/migrate.js';
import { startExpirationWorker } from '../src/expiration-worker.js';
loadEnvFile(testEnvironmentFile('.env.inventory'));
const env = z.object({ INVENTORY_TEST_PASSWORD: z.string().min(1), INVENTORY_PGHOST: z.string().default('127.0.0.1'), INVENTORY_PGPORT: z.coerce.number().default(5432) }).parse(process.env);
// Development credentials and database are never used by this suite.
const config = { host: env.INVENTORY_PGHOST, port: env.INVENTORY_PGPORT, database: 'inventory_test_db', user: 'inventory_test_user', password: env.INVENTORY_TEST_PASSWORD, max: 12, connectionTimeoutMillis: 2000, statement_timeout: 5000 };
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool(config); const pool = new Pool({ ...config, options: `-c search_path=${schema}` });
const repository = new InventoryRepository(pool, 900);
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const jwt = await createJwtFixture(); const token = `Bearer ${await jwt.sign()}`;
const workers: ReturnType<typeof startExpirationWorker>[] = [];
let server: Server; let url: string; let mode = 'normal'; let catalogPaths: string[] = [];
let app: ReturnType<typeof createApp>; let schemaCreated = false;
const application = (origin = url, timeout = 1000) => createApp(new InventoryService(repository, new CatalogClient(origin, timeout)), jwt.verify);
const put = (id = a, totalStock: unknown = 10) => request(app).put(`/inventory/${id}`).set('authorization', token).send({ totalStock });
const input = (quantity = 2, orderId = randomUUID()) => ({ orderId, items: [{ productId: a, quantity }] });
const reserve = (body = input()) => request(app).post('/inventory/reservations').set('authorization', token).send(body);
const finish = (orderId: string, action: 'confirm' | 'release') => request(app).post(`/inventory/reservations/${orderId}/${action}`).set('authorization', token).send({});
const stock = async (id = a) => (await request(app).get(`/inventory/${id}`).expect(200)).body;
const due = (id: string) => pool.query("UPDATE inventory_reservations SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE order_id = $1", [id]);
const counts = async () => ({ requests: (await pool.query('SELECT * FROM inventory_reservation_requests')).rowCount, reservations: (await pool.query('SELECT * FROM inventory_reservations')).rowCount });
beforeAll(async () => {
  expect((await admin.query('SELECT current_database() AS db, current_user AS role')).rows[0]).toEqual({ db: 'inventory_test_db', role: 'inventory_test_user' });
  await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true; await migrate(pool);
  server = createServer((req, res) => {
    catalogPaths.push(req.url!);
    if (mode === 'slow') return;
    res.writeHead(mode === 'error' ? 503 : [a, b].includes(req.url!.slice('/products/'.length)) ? 200 : 404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; app = application();
});
beforeEach(async () => { await pool.query('TRUNCATE inventory CASCADE'); await pool.query('TRUNCATE inventory_reservation_requests CASCADE'); mode = 'normal'; catalogPaths = []; app = application(); });
afterEach(async () => { await Promise.all(workers.splice(0).map((worker) => worker.stop())); vi.restoreAllMocks(); });
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  await pool.end(); if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
});
describe('Inventory stock and dependency handling', () => {
  it('provides health independently of stock', async () => { expect((await request(app).get('/health').expect(200)).body).toEqual({ status: 'ok', service: 'inventory-service' }); });
  it('initializes, reads publicly, and replaces absolute unconsumed stock', async () => {
    await put().expect(200); expect(await stock()).toEqual({ productId: a, totalStock: 10, reservedStock: 0, availableStock: 10 });
    await put(a, 3).expect(200); expect((await stock()).totalStock).toBe(3); expect(catalogPaths).toEqual([`/products/${a}`, `/products/${a}`]);
  });
  it('canonicalizes UUIDs', async () => { await put(a.toUpperCase()).expect(200); expect((await request(app).get(`/inventory/${a.toUpperCase()}`).expect(200)).body.productId).toBe(a); });
  it.each([-1, 1.5, '1', null, 2147483648])('rejects invalid stock %s', async (value) => { await put(a, value).expect(400); expect(catalogPaths).toEqual([]); });
  it.each([{ }, { totalStock: 1, extra: true }])('rejects malformed stock body %j', async (body) => { await request(app).put(`/inventory/${a}`).set('authorization', token).send(body).expect(400); });
  it('rejects invalid product ID and missing inventory', async () => { await put('bad').expect(400); await request(app).get('/inventory/bad').expect(400); await request(app).get(`/inventory/${a}`).expect(404); });
  it('rejects stock below reservations, allowing equal and increased stock', async () => {
    await put().expect(200); await reserve(input(3)).expect(201); await put(a, 2).expect(409); await put(a, 3).expect(200); expect((await stock()).availableStock).toBe(0); await put(a, 15).expect(200); expect((await stock()).availableStock).toBe(12);
  });
  it('rejects missing Catalog product without creating stock', async () => { await put(randomUUID()).expect(404); expect((await pool.query('SELECT * FROM inventory')).rowCount).toBe(0); });
  it('maps Catalog server failure to 502', async () => { mode = 'error'; await put().expect(502); });
  it('maps Catalog timeout to 504', async () => { mode = 'slow'; app = application(url, 50); await put().expect(504); });
  it('maps Catalog connection failure to 502', async () => {
    const offline = createServer(); await new Promise<void>((resolve) => offline.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(offline.address() as AddressInfo).port}`; await new Promise<void>((resolve) => offline.close(() => resolve())); app = application(origin); await put().expect(502);
  });
});
describe('Reservation validation and idempotency', () => {
  it('reserves all products with one deadline and returns stable reordered replay', async () => {
    await put().expect(200); await put(b, 20).expect(200);
    const body = { orderId: randomUUID(), items: [{ productId: b, quantity: 4 }, { productId: a, quantity: 2 }] };
    const first = await reserve(body).expect(201); const replay = await reserve({ ...body, items: [...body.items].reverse().map((item) => ({ ...item, productId: item.productId.toUpperCase() })) }).expect(201);
    expect(replay.body).toEqual(first.body); expect(first.body.status).toBe('RESERVED'); expect(new Set(first.body.items.map((item: { expiresAt: string }) => item.expiresAt)).size).toBe(1);
    expect(await stock()).toMatchObject({ reservedStock: 2, availableStock: 8 }); expect(await stock(b)).toMatchObject({ reservedStock: 4, availableStock: 16 }); expect(await counts()).toEqual({ requests: 1, reservations: 2 });
  });
  it('rolls back all products and fingerprint when one is insufficient', async () => {
    await put().expect(200); await put(b, 0).expect(200); const body = { orderId: randomUUID(), items: [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }] };
    await reserve(body).expect(409); expect((await stock()).reservedStock).toBe(0); expect(await counts()).toEqual({ requests: 0, reservations: 0 });
    await put(b, 1).expect(200); await reserve(body).expect(201);
  });
  it('rolls back missing inventory', async () => { await put().expect(200); await reserve({ orderId: randomUUID(), items: [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }] }).expect(404); expect(await counts()).toEqual({ requests: 0, reservations: 0 }); expect((await stock()).reservedStock).toBe(0); });
  it('rejects changed quantities and product sets for the same order', async () => {
    await put().expect(200); await put(b).expect(200); const body = input(); await reserve(body).expect(201);
    await reserve({ ...body, items: [{ productId: a, quantity: 3 }] }).expect(409);
    await reserve({ ...body, items: [{ productId: b, quantity: 2 }] }).expect(409);
    await reserve({ ...body, items: [...body.items, { productId: b, quantity: 1 }] }).expect(409);
    expect(await counts()).toEqual({ requests: 1, reservations: 1 });
  });
  it.each([
    {}, { orderId: 'bad', items: [{ productId: a, quantity: 1 }] }, { orderId: randomUUID(), items: [] },
    { orderId: randomUUID(), items: [{ productId: 'bad', quantity: 1 }] },
    ...[0, -1, 1.5, '2', 2147483648].map((quantity) => ({ orderId: randomUUID(), items: [{ productId: a, quantity }] })),
    { ...input(), extra: true }, { orderId: randomUUID(), items: [{ productId: a, quantity: 1, extra: true }] },
    { orderId: randomUUID(), items: [{ productId: a, quantity: 1 }, { productId: a.toUpperCase(), quantity: 1 }] },
  ])('rejects invalid reservation %j', async (body) => { await reserve(body as ReturnType<typeof input>).expect(400); expect(await counts()).toEqual({ requests: 0, reservations: 0 }); });
  it('rejects malformed JSON without revealing internal details', async () => {
    const result = await request(app).post('/inventory/reservations').set('authorization', token).set('content-type', 'application/json').send('{').expect(400); expect(result.text).not.toContain('SyntaxError');
  });
});
describe('Concurrent inventory operations', () => {
  it('allows only one contender for the last unit', async () => { await put(a, 1).expect(200); const results = await Promise.all([reserve(input(1)), reserve(input(1))]); expect(results.map((r) => r.status).sort()).toEqual([201, 409]); expect(await stock()).toMatchObject({ reservedStock: 1, availableStock: 0 }); });
  it('never oversells under contention', async () => { await put(a, 5).expect(200); const results = await Promise.all(Array.from({ length: 20 }, () => reserve(input(1)))); expect(results.filter((r) => r.status === 201)).toHaveLength(5); expect(results.filter((r) => r.status === 409)).toHaveLength(15); expect((await stock()).reservedStock).toBe(5); });
  it('serializes identical concurrent requests without extending TTL', async () => { await put().expect(200); const body = input(); const results = await Promise.all(Array.from({ length: 8 }, () => reserve(body).expect(201))); expect(results.every((r) => JSON.stringify(r.body) === JSON.stringify(results[0]!.body))).toBe(true); expect((await stock()).reservedStock).toBe(2); expect(await counts()).toEqual({ requests: 1, reservations: 1 }); });
  it('serializes conflicting concurrent order requests', async () => { await put().expect(200); const orderId = randomUUID(); const results = await Promise.all([reserve(input(2, orderId)), reserve(input(3, orderId))]); expect(results.map((r) => r.status).sort()).toEqual([201, 409]); expect(await counts()).toEqual({ requests: 1, reservations: 1 }); });
  it('locks multi-product requests consistently despite reversed input', async () => {
    await put(a, 4).expect(200); await put(b, 4).expect(200); const items = [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }];
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reserve({ orderId: randomUUID(), items: i % 2 ? [...items].reverse() : items })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(4); expect(results.filter((r) => r.status === 409)).toHaveLength(4); expect((await stock()).reservedStock).toBe(4); expect((await stock(b)).reservedStock).toBe(4);
  });
  it('keeps concurrent absolute stock updates safe', async () => { await put().expect(200); await reserve(input(5)).expect(201); const results = await Promise.all([put(a, 4), put(a, 7), put(a, 6)]); expect(results.map((r) => r.status)).toEqual([409, 200, 200]); expect((await stock()).reservedStock).toBe(5); expect([6, 7]).toContain((await stock()).totalStock); });
  it('serializes stock reductions against reservation', async () => { await put(a, 1).expect(200); const results = await Promise.all([reserve(input(1)), put(a, 0)]); expect([[201, 409], [409, 200]]).toContainEqual(results.map((r) => r.status)); const current = await stock(); expect(current.reservedStock).toBeLessThanOrEqual(current.totalStock); });
});
describe('Confirmation, release, and terminal states', () => {
  it.each(['confirm', 'release'] as const)('makes %s atomic and repeated results stable', async (action) => {
    await put().expect(200); await put(b).expect(200); const body = { orderId: randomUUID(), items: [{ productId: a, quantity: 3 }, { productId: b, quantity: 2 }] };
    await reserve(body).expect(201); const first = await finish(body.orderId, action).expect(200); expect((await finish(body.orderId, action).expect(200)).body).toEqual(first.body);
    expect(await stock()).toMatchObject({ totalStock: action === 'confirm' ? 7 : 10, reservedStock: 0, availableStock: action === 'confirm' ? 7 : 10 });
    expect((await reserve(body).expect(201)).body).toEqual(first.body); expect((await stock()).reservedStock).toBe(0);
    await finish(body.orderId, action === 'confirm' ? 'release' : 'confirm').expect(409);
  });
  it.each(['confirm', 'release'] as const)('serializes repeated concurrent %s', async (action) => {
    await put().expect(200); const body = input(3); await reserve(body).expect(201); const results = await Promise.all(Array.from({ length: 6 }, () => finish(body.orderId, action).expect(200))); expect(results.every((r) => JSON.stringify(r.body) === JSON.stringify(results[0]!.body))).toBe(true); expect((await stock()).reservedStock).toBe(0); expect((await stock()).totalStock).toBe(action === 'confirm' ? 7 : 10);
  });
  it('serializes competing confirmation and release', async () => { await put().expect(200); const body = input(); await reserve(body).expect(201); expect((await Promise.all([finish(body.orderId, 'confirm'), finish(body.orderId, 'release')])).map((r) => r.status).sort()).toEqual([200, 409]); expect((await stock()).reservedStock).toBe(0); });
  it.each(['confirm', 'release'] as const)('validates %s IDs, bodies, and missing groups', async (action) => {
    await finish('bad', action).expect(400); await finish(randomUUID(), action).expect(404);
    await request(app).post(`/inventory/reservations/${randomUUID()}/${action}`).set('authorization', token).send({ unexpected: 1 }).expect(400);
  });
  it('expires and commits a late confirmation even before worker runs', async () => { await put().expect(200); const body = input(); await reserve(body).expect(201); await due(body.orderId); await finish(body.orderId, 'confirm').expect(409); expect((await stock()).reservedStock).toBe(0); expect((await reserve(body).expect(201)).body.status).toBe('EXPIRED'); await finish(body.orderId, 'release').expect(409); });
  it('rechecks expiration after waiting for a stock lock', async () => {
    await put().expect(200); const body = input(); await reserve(body).expect(201);
    await pool.query("UPDATE inventory_reservations SET expires_at = clock_timestamp() + INTERVAL '200 milliseconds' WHERE order_id = $1", [body.orderId]);
    const blocker = await pool.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE', [a]);
    const response = finish(body.orderId, 'confirm').then((r) => r);
    try { await new Promise((resolve) => setTimeout(resolve, 300)); } finally { await blocker.query('COMMIT'); blocker.release(); }
    expect((await response).status).toBe(409); expect(await stock()).toMatchObject({ totalStock: 10, reservedStock: 0 });
  });
});
describe('Database-driven expiration and workers', () => {
  it('expires whole groups and leaves nonexpired groups untouched', async () => {
    await put().expect(200); await put(b).expect(200); const expired = { orderId: randomUUID(), items: [{ productId: a, quantity: 2 }, { productId: b, quantity: 3 }] }; const live = input(1);
    await reserve(expired).expect(201); await reserve(live).expect(201); await due(expired.orderId);
    expect(await repository.expireBatch()).toBe(1); expect(await repository.expireBatch()).toBe(0); expect(await stock()).toMatchObject({ totalStock: 10, reservedStock: 1 }); expect((await stock(b)).reservedStock).toBe(0);
    expect((await reserve(expired).expect(201)).body.status).toBe('EXPIRED'); expect((await reserve(live).expect(201)).body.status).toBe('RESERVED');
  });
  it('expires naturally after the configured TTL without changing its database deadline', async () => {
    await put().expect(200); const short = new InventoryRepository(pool, 1); const body = input(); const first = await short.reserve(body);
    workers.push(startExpirationWorker(short, 50, 100));
    await vi.waitFor(async () => expect((await stock()).reservedStock).toBe(0), { timeout: 2500, interval: 50 });
    const expired = await short.reserve(body); expect(expired.status).toBe('EXPIRED'); expect(expired.expiresAt).toBe(first.expiresAt);
  });
  it('supports multiple concurrent workers without double release', async () => {
    await put(a, 20).expect(200); const bodies = Array.from({ length: 10 }, () => input(1));
    for (const body of bodies) { await reserve(body).expect(201); await due(body.orderId); }
    // SKIP LOCKED may return a short batch when a competing transaction commits
    // after this statement's snapshot. Real workers poll again; exercise that
    // lifecycle while retaining the exact total and stock invariants.
    const counts = await Promise.all(Array.from({ length: 5 }, async () => {
      let total = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        const count = await repository.expireBatch(2); total += count;
        if (count === 0) return total;
      }
      throw new Error('Expiration worker failed to drain its bounded batches');
    }));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(10); expect(await stock()).toMatchObject({ totalStock: 20, reservedStock: 0 });
  });
  it.each(['confirm', 'release'] as const)('handles expiration versus %s safely', async (action) => {
    await put().expect(200); const body = input(); await reserve(body).expect(201); await due(body.orderId);
    const [result] = await Promise.all([finish(body.orderId, action), repository.expireBatch()]); expect(result.status).toBe(409); expect(await stock()).toMatchObject({ totalStock: 10, reservedStock: 0 }); expect((await reserve(body).expect(201)).body.status).toBe('EXPIRED');
  });
  it('skips locked order groups rather than blocking another worker', async () => {
    await put().expect(200); const body = input(); await reserve(body).expect(201); await due(body.orderId);
    const lock = await pool.connect(); await lock.query('BEGIN'); await lock.query('SELECT * FROM inventory_reservation_requests WHERE order_id = $1 FOR UPDATE', [body.orderId]);
    try { expect(await repository.expireBatch()).toBe(0); } finally { await lock.query('ROLLBACK'); lock.release(); }
    expect(await repository.expireBatch()).toBe(1);
  });
  it('starts a periodic worker, logs expiration, and stops gracefully', async () => {
    await put().expect(200); const body = input(); await reserve(body).expect(201); await due(body.orderId); const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const worker = startExpirationWorker(repository, 50, 100); workers.push(worker); await vi.waitFor(async () => { expect((await stock()).reservedStock).toBe(0); }); await worker.stop(); expect(log).toHaveBeenCalledWith('Inventory expired 1 reservation groups');
    const later = input(); await reserve(later).expect(201); await due(later.orderId); await new Promise((resolve) => setTimeout(resolve, 100)); expect((await stock()).reservedStock).toBe(2);
  });
  it('uses configured TTL without refreshing terminal replays', async () => {
    await put().expect(200); const short = new InventoryRepository(pool, 1); const body = input(); const first = await short.reserve(body);
    const delta = Date.parse(first.expiresAt) - Date.now(); expect(delta).toBeGreaterThan(500); expect(delta).toBeLessThanOrEqual(1100);
    await due(body.orderId); await short.expireBatch(); const replay = await short.reserve(body); expect(replay.status).toBe('EXPIRED'); expect(Date.parse(replay.expiresAt)).toBeLessThan(Date.now());
  });
});
describe('Independent JWT and admin authorization', () => {
  const paths = [['put', `/inventory/${a}`], ['post', '/inventory/reservations'], ['post', `/inventory/reservations/${a}/confirm`], ['post', `/inventory/reservations/${a}/release`]] as const;
  it.each(paths)('requires JWT on %s %s', async (method, path) => { const r = await request(app)[method](path).set('X-Service-Name', 'orders').send({}).expect(401); expect(r.headers['www-authenticate']).toBe('Bearer'); });
  it.each(paths)('rejects customer on %s %s', async (method, path) => { await request(app)[method](path).set('authorization', `Bearer ${await jwt.sign('customer')}`).set('X-Service-Name', 'orders').send({}).expect(403); });
  it.each([{ exp: 1 }, { iss: 'wrong' }, { aud: 'wrong' }, { sub: 'bad' }, { role: 'service' }])('rejects invalid JWT claims %j', async (claims) => { await request(app).put(`/inventory/${a}`).set('authorization', `Bearer ${await jwt.sign('admin', claims)}`).send({ totalStock: 1 }).expect(401); });
  it('rejects forged and malformed JWTs', async () => { const other = await createJwtFixture(); for (const invalid of ['broken', await other.sign()]) await request(app).put(`/inventory/${a}`).set('authorization', `Bearer ${invalid}`).send({ totalStock: 1 }).expect(401); });
});
describe('Database safeguards and rollback', () => {
  it.each([-1, 2147483648])('enforces total stock constraints %s', async (value) => { await expect(pool.query('INSERT INTO inventory (product_id, total_stock) VALUES ($1, $2)', [a, value])).rejects.toMatchObject({ code: value === -1 ? '23514' : '22003' }); });
  it.each([-1, 11])('enforces reserved stock constraints %s', async (value) => { await expect(pool.query('INSERT INTO inventory (product_id, total_stock, reserved_stock) VALUES ($1, 10, $2)', [a, value])).rejects.toMatchObject({ code: '23514' }); });
  it('enforces reservation quantity, status, uniqueness and local foreign keys', async () => {
    await put().expect(200); const body = input(); await reserve(body).expect(201);
    for (const [product, qty, status, code] of [[b, 1, 'RESERVED', '23503'], [a, 0, 'RESERVED', '23514'], [a, 1, 'BAD', '23514'], [a, 1, 'RESERVED', '23505']] as const) {
      await expect(pool.query("INSERT INTO inventory_reservations (order_id, product_id, quantity, status, expires_at) VALUES ($1,$2,$3,$4,NOW())", [body.orderId, product, qty, status])).rejects.toMatchObject({ code });
    }
  });
  it('rolls back stock and fingerprint on a failed reservation insert', async () => {
    await put().expect(200); await pool.query("CREATE FUNCTION fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private SQL detail'; END $$"); await pool.query('CREATE TRIGGER fail_insert BEFORE INSERT ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION fail_insert()');
    try { const r = await reserve().expect(500); expect(r.text).not.toContain('private SQL detail'); expect((await stock()).reservedStock).toBe(0); expect(await counts()).toEqual({ requests: 0, reservations: 0 }); }
    finally { await pool.query('DROP TRIGGER fail_insert ON inventory_reservations'); await pool.query('DROP FUNCTION fail_insert()'); }
  });
  it('rolls back reservation transitions on stock write failure', async () => {
    await put().expect(200); const body = input(); await reserve(body).expect(201);
    await pool.query("CREATE FUNCTION fail_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private detail'; END $$"); await pool.query('CREATE TRIGGER fail_update BEFORE UPDATE ON inventory FOR EACH ROW EXECUTE FUNCTION fail_update()');
    try { await finish(body.orderId, 'confirm').expect(500); expect((await reserve(body).expect(201)).body.status).toBe('RESERVED'); expect((await stock()).reservedStock).toBe(2); }
    finally { await pool.query('DROP TRIGGER fail_update ON inventory'); await pool.query('DROP FUNCTION fail_update()'); }
  });
  it('returns sanitized database errors and worker failure logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {}); await pool.query('ALTER TABLE inventory RENAME TO inventory_unavailable');
    try { const r = await request(app).get(`/inventory/${a}`).expect(500); expect(r.text).not.toContain('SELECT'); const worker = startExpirationWorker(repository, 50, 100); workers.push(worker); // Force its database lookup to fail too.
      await pool.query('ALTER TABLE inventory_reservation_requests RENAME TO requests_unavailable');
      try { await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Inventory expiration failed')); await worker.stop(); }
      finally { await pool.query('ALTER TABLE requests_unavailable RENAME TO inventory_reservation_requests'); }
    } finally { await pool.query('ALTER TABLE inventory_unavailable RENAME TO inventory'); }
  });
  it('rolls back a worker failure without losing reservation state or held stock', async () => {
    await put().expect(200); const body = input(); await reserve(body).expect(201); await due(body.orderId);
    await pool.query("CREATE FUNCTION fail_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private detail'; END $$");
    await pool.query('CREATE TRIGGER fail_expiry BEFORE UPDATE ON inventory FOR EACH ROW EXECUTE FUNCTION fail_expiry()');
    try { await expect(repository.expireBatch()).rejects.toThrow('Internal server error'); expect((await reserve(body).expect(201)).body.status).toBe('RESERVED'); expect((await stock()).reservedStock).toBe(2); }
    finally { await pool.query('DROP TRIGGER fail_expiry ON inventory'); await pool.query('DROP FUNCTION fail_expiry()'); }
    expect(await repository.expireBatch()).toBe(1); expect((await stock()).reservedStock).toBe(0);
  });
  it('tracks repeatable migrations', async () => { await migrate(pool); expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(4); });
  it.each(['inventory_db', 'catalog_db', 'auth_db', 'orders_db', 'catalog_test_db', 'auth_test_db', 'orders_test_db'])('test role cannot connect to %s', async (database) => { const forbidden = new Pool({ ...config, database }); try { await expect(forbidden.query('SELECT 1')).rejects.toMatchObject({ code: '42501' }); } finally { await forbidden.end(); } });
});
