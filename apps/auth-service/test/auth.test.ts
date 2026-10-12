import { bootstrapAdmin } from '../src/bootstrap-admin.js';
import { verifyDatabaseBoundary } from '../src/db/pool.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { decodeJwt, SignJWT } from 'jose';
import { z } from 'zod';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJwtFixture } from '../../../test/jwt-fixture.js';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth-service.js';
import { UserRepository } from '../src/user-repository.js';
import { createTokenService } from '../src/token-service.js';
import { migrate } from '../src/db/migrate.js';

if (existsSync('.env.auth')) loadEnvFile('.env.auth');
const environment = z.object({
  AUTH_PGHOST: z.string().min(1).default('127.0.0.1'),
  AUTH_PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  AUTH_TEST_PASSWORD: z.string().min(1),
}).parse(process.env);
const config = {
  host: environment.AUTH_PGHOST, port: environment.AUTH_PGPORT,
  database: 'auth_test_db', user: 'auth_test_user', password: environment.AUTH_TEST_PASSWORD,
  max: 2, connectionTimeoutMillis: 2000, statement_timeout: 2000,
};
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool(config);
const pool = new Pool({ ...config, options: `-c search_path=${schema}` });
const jwt = await createJwtFixture();
const tokens = await createTokenService(jwt.privatePem, jwt.publicPem, jwt.settings, 900);
const users = new UserRepository(pool);
const service = await AuthService.create(users, tokens);
const app = createApp(service);
const credentials = { email: 'user@example.com', password: 'SecurePassword123!' };
let schemaCreated = false;

beforeAll(async () => {
  const identity = await admin.query('SELECT current_database() AS db, current_user AS role');
  expect(identity.rows[0]).toEqual({ db: 'auth_test_db', role: 'auth_test_user' });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await migrate(pool);
});
beforeEach(async () => { await pool.query('TRUNCATE users'); });
afterAll(async () => {
  await pool.end();
  if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

async function register() {
  return (await request(app).post('/auth/register').send(credentials).expect(201)).body as { id: string; email: string; role: string };
}
async function login() {
  return (await request(app).post('/auth/login').send(credentials).expect(200)).body as { accessToken: string; tokenType: string; expiresIn: number };
}

describe('Auth registration with real PostgreSQL', () => {
  it('reports health', async () => {
    const response = await request(app).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', service: 'auth-service' });
  });
  it('normalizes email, assigns customer, and stores only an argon2id hash', async () => {
    const response = await request(app).post('/auth/register').send({ ...credentials, email: '  USER@EXAMPLE.COM ' }).expect(201);
    expect(z.uuid().safeParse(response.body.id).success).toBe(true);
    expect(response.body).toEqual({ id: response.body.id, email: credentials.email, role: 'customer' });
    expect(response.headers['cache-control']).toBe('no-store');
    const row = (await pool.query('SELECT * FROM users')).rows[0];
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(credentials.password);
    expect(await argon2.verify(row.password_hash, credentials.password)).toBe(true);
  });
  it.each(['user@example.com', 'USER@EXAMPLE.COM'])('rejects duplicate email %s', async (email) => {
    await register();
    const response = await request(app).post('/auth/register').send({ ...credentials, email }).expect(409);
    expect(response.body).toEqual({ error: { message: 'Email already registered' } });
    expect((await pool.query('SELECT * FROM users')).rowCount).toBe(1);
  });
  it('handles concurrent duplicate registrations through the unique index', async () => {
    const responses = await Promise.all([request(app).post('/auth/register').send(credentials), request(app).post('/auth/register').send(credentials)]);
    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    expect((await pool.query('SELECT * FROM users')).rowCount).toBe(1);
  });
  it.each([
    ['invalid email', { ...credentials, email: 'invalid' }],
    ['missing password', { email: credentials.email }],
    ['short password', { ...credentials, password: 'short' }],
    ['long password', { ...credentials, password: 'x'.repeat(129) }],
    ['non-string password', { ...credentials, password: 123456789012 }],
    ['role escalation', { ...credentials, role: 'admin' }],
    ['unknown field', { ...credentials, extra: 'value' }],
  ])('rejects %s', async (_label, body) => {
    await request(app).post('/auth/register').send(body).expect(400);
    expect((await pool.query('SELECT * FROM users')).rowCount).toBe(0);
  });
  it('enforces role and case-insensitive email constraints in PostgreSQL', async () => {
    await register();
    await expect(pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)',
      ['USER@EXAMPLE.COM', 'test-hash', 'customer'])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)',
      ['other@example.com', 'test-hash', 'owner'])).rejects.toMatchObject({ code: '23514' });
  });
  it('runs migrations repeatedly without duplicates', async () => {
    await migrate(pool);
    expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(1);
  });
});

describe('Auth login and JWT verification', () => {
  it('issues an RS256 JWT with bounded claims and no password hash', async () => {
    const user = await register();
    const response = await request(app).post('/auth/login').send({ ...credentials, email: 'USER@EXAMPLE.COM' }).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['accessToken', 'expiresIn', 'tokenType']);
    expect(response.body.tokenType).toBe('Bearer');
    expect(response.body.expiresIn).toBe(900);
    const payload = decodeJwt(response.body.accessToken);
    expect(payload).toMatchObject({ sub: user.id, role: 'customer', iss: jwt.settings.issuer, aud: jwt.settings.audience });
    expect(payload.exp! - payload.iat!).toBe(900);
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'role', 'sub']);
    expect(await jwt.verify(`Bearer ${response.body.accessToken}`)).toEqual({ id: user.id, role: 'customer' });
  });
  it('uses identical 401 errors for wrong passwords and unknown users', async () => {
    await register();
    const wrong = await request(app).post('/auth/login').send({ ...credentials, password: 'WrongPassword123!' }).expect(401);
    const absent = await request(app).post('/auth/login').send({ ...credentials, email: 'absent@example.com' }).expect(401);
    expect(wrong.body).toEqual({ error: { message: 'Invalid credentials' } });
    expect(absent.body).toEqual(wrong.body);
  });
  it('validates login requests and malformed JSON', async () => {
    await request(app).post('/auth/login').send({ email: 'invalid', password: 'valid' }).expect(400);
    await request(app).post('/auth/login').send({ email: credentials.email }).expect(400);
    await request(app).post('/auth/register').set('content-type', 'application/json').send('{broken').expect(400);
  });
  it('returns only the current public user for a valid token', async () => {
    const user = await register();
    const result = await login();
    const response = await request(app).get('/auth/me').set('authorization', `Bearer ${result.accessToken}`).expect(200);
    expect(response.body).toEqual(user);
  });
  it('rejects missing and malformed authorization', async () => {
    await request(app).get('/auth/me').expect(401);
    await request(app).get('/auth/me').set('authorization', 'Basic token').expect(401);
    await request(app).get('/auth/me').set('authorization', 'Bearer invalid').expect(401);
  });
  it('rejects wrong signature, expired token, wrong issuer/audience and invalid claims', async () => {
    const user = await register();
    const other = await createJwtFixture();
    const invalid = [
      await other.sign('customer', { sub: user.id }),
      await jwt.sign('customer', { sub: user.id, exp: 1 }),
      await jwt.sign('customer', { sub: user.id, iss: 'wrong' }),
      await jwt.sign('customer', { sub: user.id, aud: 'wrong' }),
      await jwt.sign('customer', { sub: 'not-a-uuid' }),
      await jwt.sign('customer', { sub: user.id, role: 'owner' }),
      await jwt.sign('customer', { sub: user.id, exp: undefined }),
      await jwt.sign('customer', { sub: user.id, nbf: Math.floor(Date.now() / 1000) + 300 }),
      await new SignJWT({ sub: user.id, role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32)),
    ];
    for (const token of invalid) await request(app).get('/auth/me').set('authorization', `Bearer ${token}`).expect(401);
  });
  it('rejects deleted users and reads current roles instead of trusting stale claims on /me', async () => {
    const user = await register();
    const result = await login();
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    const response = await request(app).get('/auth/me').set('authorization', `Bearer ${result.accessToken}`).expect(200);
    expect(response.body.role).toBe('admin');
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    await request(app).get('/auth/me').set('authorization', `Bearer ${result.accessToken}`).expect(401);
  });
  it('fails startup for mismatched signing/verification keys', async () => {
    const other = await createJwtFixture();
    await expect(createTokenService(jwt.privatePem, other.publicPem, jwt.settings, 900)).rejects.toThrow('Unauthorized');
  });
  it('sanitizes unexpected database failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await pool.query('ALTER TABLE users RENAME TO unavailable_users');
    try {
      const response = await request(app).post('/auth/register').send(credentials).expect(500);
      expect(response.body).toEqual({ error: { message: 'Internal server error' } });
      await request(app).post('/auth/login').send(credentials).expect(500);
    } finally {
      await pool.query('ALTER TABLE unavailable_users RENAME TO users');
      log.mockRestore();
    }
  });
  it.each(['auth_db', 'catalog_db', 'catalog_test_db'])('test role cannot connect to %s', async (database) => {
    const forbidden = new Pool({ ...config, database });
    try { await expect(forbidden.query('SELECT 1')).rejects.toMatchObject({ code: '42501' }); }
    finally { await forbidden.end(); }
  });
});

describe('Local admin bootstrap safety', () => {
  const adminInput = { email: 'admin@example.com', password: 'AdminPassword123!' };
  it('creates an admin that can login with a signed admin role', async () => {
    expect(await bootstrapAdmin(users, adminInput, 'test')).toBe(true);
    const response = await request(app).post('/auth/login').send(adminInput).expect(200);
    expect((await jwt.verify(`Bearer ${response.body.accessToken}`)).role).toBe('admin');
  });
  it('leaves existing admin roles and password hashes unchanged', async () => {
    await bootstrapAdmin(users, adminInput, 'test');
    const before = await users.findByEmail(adminInput.email);
    expect(await bootstrapAdmin(users, { ...adminInput, password: 'DifferentPassword123!' }, 'test')).toBe(false);
    expect(await users.findByEmail(adminInput.email)).toEqual(before);
    await request(app).post('/auth/login').send(adminInput).expect(200);
  });
  it('refuses to elevate an existing customer', async () => {
    await register();
    await expect(bootstrapAdmin(users, credentials, 'test')).rejects.toThrow('Existing customer cannot be promoted');
    expect((await users.findByEmail(credentials.email))?.role).toBe('customer');
  });
  it('is disabled in production before any users are created', async () => {
    await expect(bootstrapAdmin(users, adminInput, 'production')).rejects.toThrow('disabled in production');
    expect((await pool.query('SELECT * FROM users')).rowCount).toBe(0);
  });
  it('rejects starting production Auth against a test database', async () => {
    await expect(verifyDatabaseBoundary(pool)).rejects.toThrow('Auth requires its own');
  });
});
