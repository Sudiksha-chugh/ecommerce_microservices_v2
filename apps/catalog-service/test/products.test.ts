import { createJwtFixture } from '../../../test/jwt-fixture.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { Pool } from 'pg';
import { z } from 'zod';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ProductRepository } from '../src/product-repository.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

if (existsSync('.env')) loadEnvFile('.env');
const environment = z.object({
  PGHOST: z.string().min(1).default('127.0.0.1'),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  CATALOG_TEST_PASSWORD: z.string().min(1),
}).parse(process.env);
// Never use PGDATABASE, PGUSER or PGPASSWORD for tests.
const config = {
  host: environment.PGHOST, port: environment.PGPORT,
  database: 'catalog_test_db', user: 'catalog_test_user', password: environment.CATALOG_TEST_PASSWORD,
  max: 2, connectionTimeoutMillis: 2000, statement_timeout: 2000,
};
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool(config);
const pool = new Pool({ ...config, options: `-c search_path=${schema}` });
const jwt = await createJwtFixture();
const adminHeader = `Bearer ${await jwt.sign()}`;
const app = createApp(new ProductRepository(pool), jwt.verify);
const notebookId = '11111111-1111-4111-8111-111111111111';
let schemaCreated = false;

beforeAll(async () => {
  const identity = await admin.query('SELECT current_database() AS db, current_user AS role');
  expect(identity.rows[0]).toEqual({ db: 'catalog_test_db', role: 'catalog_test_user' });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await migrate(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE products');
  await seed(pool);
});

afterAll(async () => {
  await pool.end();
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

describe('Catalog with real PostgreSQL', () => {
  it('reports health', async () => {
    const response = await request(app).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', service: 'catalog-service' });
  });

  it('lists the three persisted products', async () => {
    const response = await request(app).get('/products').expect(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.map((product: { name: string }) => product.name)).toEqual(['Notebook', 'Coffee mug', 'Desk lamp']);
    for (const product of response.body) {
      expect(z.uuid().safeParse(product.id).success).toBe(true);
      expect(Number.isInteger(product.priceInPaise)).toBe(true);
      expect(product.priceInPaise).toBeGreaterThanOrEqual(0);
    }
  });

  it('looks up a persisted product by UUID', async () => {
    const response = await request(app).get(`/products/${notebookId}`).expect(200);
    expect(response.body).toEqual({
      id: notebookId, name: 'Notebook', description: 'A ruled paper notebook.', priceInPaise: 14900,
    });
  });

  it('returns 404 for an absent UUID', async () => {
    const response = await request(app).get('/products/44444444-4444-4444-8444-444444444444').expect(404);
    expect(response.body).toEqual({ error: { message: 'Product not found' } });
  });

  it('rejects invalid IDs before querying the database', async () => {
    const repository = new ProductRepository(pool);
    const lookup = vi.spyOn(repository, 'findById');
    const response = await request(createApp(repository, jwt.verify)).get('/products/not-a-uuid').expect(400);
    expect(response.body).toEqual({ error: { message: 'Invalid product ID' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns a sanitized 503 on a real database query failure', async () => {
    await pool.query('ALTER TABLE products RENAME TO unavailable_products');
    try {
      const response = await request(app).get('/products').expect(503);
      expect(response.body).toEqual({ error: { message: 'Catalog database unavailable' } });
      await request(app).get(`/products/${notebookId}`).expect(503);
      await request(app).get('/health').expect(200);
    } finally {
      await pool.query('ALTER TABLE unavailable_products RENAME TO products');
    }
  });

  it('runs migrations and seeds repeatedly without duplication', async () => {
    await migrate(pool);
    await seed(pool);
    expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(2);
    expect((await pool.query('SELECT * FROM products')).rowCount).toBe(3);
  });

  it('enforces prices and supplies UUID and timestamp defaults', async () => {
    await expect(pool.query(`INSERT INTO products (name, description, price_in_paise)
      VALUES ($1, $2, $3)`, ['Invalid', 'Invalid price', -1])).rejects.toMatchObject({ code: '23514' });
    const result = await pool.query(`INSERT INTO products (name, description, price_in_paise)
      VALUES ($1, $2, $3) RETURNING id, created_at, updated_at`, ['Free', 'Free sample', 0]);
    expect(z.uuid().safeParse(result.rows[0].id).success).toBe(true);
    expect(result.rows[0].created_at).toBeInstanceOf(Date);
    expect(result.rows[0].updated_at).toBeInstanceOf(Date);
  });

  it('cannot connect to the development database with test credentials', async () => {
    const forbidden = new Pool({ ...config, database: 'catalog_db' });
    try {
      await expect(forbidden.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await forbidden.end();
    }
  });
});

const keyboard = { name: 'Mechanical Keyboard', description: 'Wireless mechanical keyboard', priceInPaise: 499900 };
const absentId = '44444444-4444-4444-8444-444444444444';

describe('Catalog product management with real PostgreSQL', () => {
  it('creates a product with a database-generated UUID and Location', async () => {
    const response = await request(app).post('/products').set('authorization', adminHeader).send({ ...keyboard, name: '  Mechanical Keyboard  ' }).expect(201);
    expect(z.uuid().safeParse(response.body.id).success).toBe(true);
    expect(response.headers.location).toBe(`/products/${response.body.id}`);
    expect(response.body).toEqual({ ...keyboard, id: response.body.id });
    const persisted = await request(app).get(response.headers.location!).expect(200);
    expect(persisted.body).toEqual(response.body);
  });

  it.each([
    ['missing name', { description: 'Test', priceInPaise: 10 }],
    ['empty name', { ...keyboard, name: '   ' }],
    ['long name', { ...keyboard, name: 'x'.repeat(256) }],
    ['negative price', { ...keyboard, priceInPaise: -1 }],
    ['price string', { ...keyboard, priceInPaise: '10' }],
    ['fractional price', { ...keyboard, priceInPaise: 1.5 }],
    ['unsafe price', { ...keyboard, priceInPaise: Number.MAX_SAFE_INTEGER + 1 }],
    ['unknown property', { ...keyboard, stock: 1 }],
    ['missing description', { name: 'Test', priceInPaise: 10 }],
    ['missing price', { name: 'Test', description: 'Test' }],
    ['null description', { ...keyboard, description: null }],
    ['array body', [keyboard]],
  ])('rejects creation with %s', async (_label, body) => {
    await request(app).post('/products').set('authorization', adminHeader).send(body).expect(400);
    expect((await pool.query('SELECT * FROM products')).rowCount).toBe(3);
  });

  it('accepts zero and the maximum safe integer and preserves SQL-like text', async () => {
    for (const price of [0, Number.MAX_SAFE_INTEGER]) {
      const response = await request(app).post('/products').set('authorization', adminHeader).send({
        name: "Keyboard'; DROP TABLE products; --", description: '', priceInPaise: price,
      }).expect(201);
      expect(response.body.priceInPaise).toBe(price);
      const read = await request(app).get(response.headers.location!).expect(200);
      expect(read.body).toEqual(response.body);
    }
  });

  it('partially updates while preserving unspecified fields and created_at', async () => {
    await pool.query("UPDATE products SET updated_at = '2000-01-01' WHERE id = $1", [notebookId]);
    const before = (await pool.query('SELECT created_at, updated_at FROM products WHERE id = $1', [notebookId])).rows[0];
    const response = await request(app).patch(`/products/${notebookId}`).set('authorization', adminHeader).send({ name: '  Renamed notebook  ' }).expect(200);
    expect(response.body).toEqual({ id: notebookId, name: 'Renamed notebook', description: 'A ruled paper notebook.', priceInPaise: 14900 });
    const after = (await pool.query('SELECT created_at, updated_at FROM products WHERE id = $1', [notebookId])).rows[0];
    expect(after.created_at).toEqual(before.created_at);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect((await request(app).get(`/products/${notebookId}`)).body).toEqual(response.body);
  });

  it('updates multiple fields including zero price and empty description', async () => {
    const response = await request(app).patch(`/products/${notebookId}`).set('authorization', adminHeader).send({ ...keyboard, description: '', priceInPaise: 0 }).expect(200);
    expect(response.body).toEqual({ ...keyboard, description: '', priceInPaise: 0, id: notebookId });
  });

  it.each([{}, { name: '' }, { name: 'x'.repeat(256) }, { description: null },
    { priceInPaise: -1 }, { priceInPaise: '1' }, { priceInPaise: 0.5 },
    { priceInPaise: Number.MAX_SAFE_INTEGER + 1 }, { unknown: 'field' },
  ])('rejects invalid partial updates: %j', async (body) => {
    await request(app).patch(`/products/${notebookId}`).set('authorization', adminHeader).send(body).expect(400);
    expect((await request(app).get(`/products/${notebookId}`)).body.name).toBe('Notebook');
  });

  it('returns 400 for invalid update UUID and 404 for an absent UUID', async () => {
    await request(app).patch('/products/invalid').set('authorization', adminHeader).send({ name: 'Valid' }).expect(400);
    await request(app).patch(`/products/${absentId}`).set('authorization', adminHeader).send({ name: 'Valid' }).expect(404);
  });

  it('deletes with no response body and makes the product unavailable', async () => {
    const created = await request(app).post('/products').set('authorization', adminHeader).send(keyboard).expect(201);
    const response = await request(app).delete(created.headers.location!).set('authorization', adminHeader).expect(204);
    expect(response.text).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
    await request(app).get(created.headers.location!).expect(404);
    await request(app).delete(created.headers.location!).set('authorization', adminHeader).expect(404);
    expect((await pool.query('SELECT * FROM products')).rowCount).toBe(3);
  });

  it('rejects invalid delete UUID and returns 404 for an absent product', async () => {
    await request(app).delete('/products/invalid').set('authorization', adminHeader).expect(400);
    await request(app).delete(`/products/${absentId}`).set('authorization', adminHeader).expect(404);
  });

  it('returns 400 for malformed JSON', async () => {
    for (const method of ['post', 'patch'] as const) {
      await request(app)[method](method === 'post' ? '/products' : `/products/${notebookId}`).set('authorization', adminHeader)
        .set('content-type', 'application/json').send('{broken').expect(400);
    }
  });

  it('returns sanitized 500 responses for unexpected write database errors', async () => {
    await pool.query('ALTER TABLE products RENAME TO unavailable_products');
    try {
      for (const [method, path] of [['post', '/products'], ['patch', `/products/${notebookId}`], ['delete', `/products/${notebookId}`]] as const) {
        const response = await request(app)[method](path).set('authorization', adminHeader).send(keyboard).expect(500);
        expect(response.body).toEqual({ error: { message: 'Internal server error' } });
      }
    } finally {
      await pool.query('ALTER TABLE unavailable_products RENAME TO products');
    }
  });
});

describe('Catalog verifies JWTs independently', () => {
  it.each(['post', 'patch', 'delete'] as const)('rejects unauthenticated %s even with a forged role header', async (method) => {
    const path = method === 'post' ? '/products' : `/products/${notebookId}`;
    const response = await request(app)[method](path).set('x-user-role', 'admin').send(keyboard).expect(401);
    expect(response.body).toEqual({ error: { message: 'Unauthorized' } });
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });
  it.each(['post', 'patch', 'delete'] as const)('rejects customer %s tokens', async (method) => {
    const token = await jwt.sign('customer');
    const path = method === 'post' ? '/products' : `/products/${notebookId}`;
    await request(app)[method](path).set('authorization', `Bearer ${token}`).send(keyboard).expect(403);
  });
  it('rejects malformed, expired, wrong-issuer, wrong-audience and wrong-signature tokens', async () => {
    const other = await createJwtFixture();
    for (const token of [
      'not-a-token', await jwt.sign('admin', { exp: 1 }),
      await jwt.sign('admin', { iss: 'wrong' }), await jwt.sign('admin', { aud: 'wrong' }),
      await other.sign(), await jwt.sign('admin', { role: 'superadmin' }),
      await jwt.sign('admin', { sub: 'invalid-uuid' }),
    ]) {
      await request(app).post('/products').set('authorization', `Bearer ${token}`).send(keyboard).expect(401);
    }
    expect((await pool.query('SELECT * FROM products')).rowCount).toBe(3);
  });
  it('allows public reads without a token', async () => {
    await request(app).get('/products').expect(200);
    await request(app).get(`/products/${notebookId}`).expect(200);
  });
});
