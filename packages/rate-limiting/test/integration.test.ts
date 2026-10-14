import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../apps/api-gateway/src/app.js';
import { createJwtFixture } from '../../../test/jwt-fixture.js';
import { isolatedRedis, storeFixture, upstream, redisProxy, ready, gatewayProcess } from './fixture.js';
import { bucketKey, DistributedRateLimiter, RedisRateLimitStore, RateLimitMetrics, defaultPolicies,
  type ProtectionOptions, type Policies, type BucketPolicy, type DecisionLog } from '../src/index.js';
let redis: Awaited<ReturnType<typeof isolatedRedis>>;
let jwt: Awaited<ReturnType<typeof createJwtFixture>>;
let target: Awaited<ReturnType<typeof upstream>>;
const cleanup: (() => Promise<unknown>)[] = [];
const identity = { type: 'ip' as const, value: '192.0.2.1' };
const slow = (capacity: number): BucketPolicy => ({ capacity, refillTokens: 1, windowMs: 60_000 });
beforeAll(async () => { redis = await isolatedRedis(); jwt = await createJwtFixture(); target = await upstream(); }, 60_000);
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); target.seen.splice(0); target.behavior.status = 200; });
afterAll(async () => { await target?.close(); await redis?.close(); }, 60_000);
async function fixture(overrides: Partial<Policies> = {}, timeout = 500, maxPending = 1000, url = redis.url) {
  const f = await storeFixture(url, overrides, timeout, maxPending); cleanup.push(() => f.store.close()); return f;
}
function gateway(f: Awaited<ReturnType<typeof fixture>>, options: Partial<ProtectionOptions> = {}) {
  const logs: DecisionLog[] = []; const metrics = new RateLimitMetrics();
  const app = createApp({ CATALOG_SERVICE_URL: target.url, CATALOG_REQUEST_TIMEOUT_MS: 1000,
    AUTH_SERVICE_URL: target.url, CART_SERVICE_URL: target.url, ORDERS_SERVICE_URL: target.url,
    INVENTORY_SERVICE_URL: target.url, PAYMENTS_SERVICE_URL: target.url }, {
    limiter: f.limiter, verify: jwt.verify, trustedProxies: [], failOpenPublic: true, metrics,
    log: record => logs.push(record), ...options,
  });
  return { app, logs, metrics };
}
const redisTime = async () => { const result = await redis.client.sendCommand(['TIME']) as string[]; return Number(result[0]) * 1000 + Math.floor(Number(result[1]) / 1000); };
async function seed(key: string, policy: BucketPolicy, tokens: number, last: number) {
  await redis.client.hSet(key, { tokens, last, capacity: policy.capacity, refill: policy.refillTokens, window: policy.windowMs });
  await redis.client.pExpire(key, 3_600_000);
}
describe('real Redis atomic token buckets', () => {
  it('starts at capacity, consumes exactly one token and reports integer retry/reset timing', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(3) });
    const first = await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity);
    expect(first.allowed).toBe(true); expect(first.remaining).toBe(2); expect(first.capacity).toBe(3);
    await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity); await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity);
    const denied = await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity);
    expect(denied.allowed).toBe(false); expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(59_000); expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(Number.isInteger(denied.retryAfterMs)).toBe(true); expect(denied.resetMs).toBeGreaterThan(179_000);
  });
  it('refills using Redis time, caps capacity after idle time and cannot go negative', async () => {
    const policy = { capacity: 5, refillTokens: 2, windowMs: 1000 };
    const f = await fixture({ GLOBAL_ANONYMOUS: policy });
    const key = bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', identity);
    await seed(key, policy, 0, await redisTime() - 1000);
    const refill = await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity);
    expect(refill.allowed).toBe(true); expect(refill.remaining).toBeGreaterThanOrEqual(1); expect(refill.remaining).toBeLessThanOrEqual(4);
    await seed(key, policy, 0, await redisTime() - 100_000);
    const capped = await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity); expect(capped.remaining).toBe(4);
    const state = await redis.client.hGetAll(key); expect(Number(state.tokens)).toBeGreaterThanOrEqual(0);
    expect(Number(state.tokens)).toBeLessThanOrEqual(policy.capacity * policy.windowMs);
  });
  it('does not double-refill when Redis time moves behind persisted time', async () => {
    const policy = { capacity: 1, refillTokens: 1, windowMs: 1000 };
    const f = await fixture({ GLOBAL_ANONYMOUS: policy }); const key = bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', identity);
    const future = await redisTime() + 30_000; await seed(key, policy, 0, future);
    for (let i = 0; i < 3; i++) expect((await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity)).allowed).toBe(false);
    expect(Number(await redis.client.hGet(key, 'last'))).toBe(future);
  });
  it('uses independent refill clocks for composed buckets', async () => {
    const policy = { capacity: 1, refillTokens: 1, windowMs: 1000 };
    const f = await fixture({ GLOBAL_ANONYMOUS: policy, AUTH_LOGIN: policy }); const now = await redisTime();
    const first = bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', identity), second = bucketKey(f.prefix, 'AUTH_LOGIN', identity);
    await seed(first, policy, 0, now + 30_000); await seed(second, policy, 0, now);
    expect((await f.limiter.decide(['GLOBAL_ANONYMOUS', 'AUTH_LOGIN'], identity)).allowed).toBe(false);
    expect(Number(await redis.client.hGet(second, 'tokens'))).toBeLessThan(1000);
    expect(Number(await redis.client.hGet(second, 'last'))).toBeLessThan(now + 30_000);
  });
  it('expires idle keys within a bounded TTL and returns a full bucket afterwards', async () => {
    const policy = { capacity: 1, refillTokens: 1, windowMs: 1000 };
    const f = await fixture({ GLOBAL_ANONYMOUS: policy }); const key = bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', identity);
    await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity); const ttl = await redis.client.pTTL(key);
    expect(ttl).toBeGreaterThan(0); expect(ttl).toBeLessThanOrEqual(1000);
    const deadline = Date.now() + 3000;
    while (await redis.client.exists(key) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(await redis.client.exists(key)).toBe(0);
    expect((await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity)).remaining).toBe(0);
    expect((await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity)).allowed).toBe(false);
  });
  it('consumes all required buckets atomically and spends none when one denies', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(10), AUTH_LOGIN: slow(1) });
    expect((await f.limiter.decide(['GLOBAL_ANONYMOUS', 'AUTH_LOGIN'], identity)).allowed).toBe(true);
    const global = bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', identity); const before = Number(await redis.client.hGet(global, 'tokens'));
    const denied = await f.limiter.decide(['GLOBAL_ANONYMOUS', 'AUTH_LOGIN'], identity);
    expect(denied.allowed).toBe(false); expect(denied.policy).toBe('AUTH_LOGIN');
    const after = Number(await redis.client.hGet(global, 'tokens')); expect(after).toBeGreaterThanOrEqual(before);
    expect(Math.floor(after / 60_000)).toBe(9);
  });
  it('does not partially spend the sensitive bucket when the global bucket denies', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(1), AUTH_LOGIN: slow(10) });
    await f.limiter.decide(['GLOBAL_ANONYMOUS', 'AUTH_LOGIN'], identity);
    const denied = await f.limiter.decide(['GLOBAL_ANONYMOUS', 'AUTH_LOGIN'], identity);
    expect(denied.policy).toBe('GLOBAL_ANONYMOUS'); expect(denied.allowed).toBe(false);
    const key = bucketKey(f.prefix, 'AUTH_LOGIN', identity); expect(Math.floor(Number(await redis.client.hGet(key, 'tokens')) / 60_000)).toBe(9);
  });
  it('atomically shares state between two independent clients at high concurrency', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(40), AUTH_LOGIN: slow(15) });
    const g = await fixture(); g.limiter = new DistributedRateLimiter(g.store, f.prefix, f.limiter.policies);
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => (i % 2 ? f : g).limiter.decide(['GLOBAL_ANONYMOUS', 'AUTH_LOGIN'], identity)));
    expect(results.filter(r => r.allowed)).toHaveLength(15); expect(results.filter(r => !r.allowed)).toHaveLength(285);
    expect(Math.floor(Number(await redis.client.hGet(bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', identity), 'tokens')) / 60_000)).toBe(25);
    expect(Number(await redis.client.hGet(bucketKey(f.prefix, 'AUTH_LOGIN', identity), 'tokens'))).toBeGreaterThanOrEqual(0);
  });
  it('refills exactly once under concurrency using persisted Redis timestamps', async () => {
    const policy = { capacity: 100, refillTokens: 2, windowMs: 1000 };
    const f = await fixture({ GLOBAL_ANONYMOUS: policy }); const key = bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', identity);
    const last = await redisTime() - 2000; await seed(key, policy, 0, last);
    const results = await Promise.all(Array.from({ length: 100 }, () => f.limiter.decide(['GLOBAL_ANONYMOUS'], identity)));
    const allowed = results.filter(r => r.allowed).length; expect(allowed).toBeGreaterThanOrEqual(4); expect(allowed).toBeLessThan(100);
    const state = await redis.client.hGetAll(key);
    expect(Number(state.tokens)).toBe((Number(state.last) - last) * policy.refillTokens - allowed * policy.windowMs);
    expect(Number(state.tokens)).toBeGreaterThanOrEqual(0);
  });
  it('rejects incompatible configurations without spending any bucket', async () => {
    const f = await fixture(); await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity);
    const inconsistent = new DistributedRateLimiter(f.store, f.prefix, { ...defaultPolicies, GLOBAL_ANONYMOUS: slow(1) });
    await expect(inconsistent.decide(['AUTH_LOGIN', 'GLOBAL_ANONYMOUS'], identity)).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(await redis.client.exists(bucketKey(f.prefix, 'AUTH_LOGIN', identity))).toBe(0);
  });
  it('has no collisions with Cart or other rate-limit namespaces', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(1) }); const g = await fixture({ GLOBAL_ANONYMOUS: slow(1) });
    const cart = `cart:test-${randomUUID()}`; await redis.client.set(cart, 'preserved-cart');
    try {
      await f.limiter.decide(['GLOBAL_ANONYMOUS'], identity);
      expect((await g.limiter.decide(['GLOBAL_ANONYMOUS'], identity)).allowed).toBe(true);
      expect(await redis.client.get(cart)).toBe('preserved-cart');
    } finally { await redis.client.del(cart); }
  });
});
describe('real Gateway identity, routes and horizontal scaling', () => {
  it('shares one burst across two Gateway instances without forwarding denied requests', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(20) }); const g = await fixture();
    g.limiter = new DistributedRateLimiter(g.store, f.prefix, f.limiter.policies);
    const a = gateway(f).app, b = gateway(g).app;
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => request(i % 2 ? a : b).get('/products')));
    expect(results.filter(r => r.status === 200)).toHaveLength(20); expect(results.filter(r => r.status === 429)).toHaveLength(80);
    expect(target.seen).toHaveLength(20);
  });
  it('direct clients cannot spoof X-Forwarded-For, X-Real-IP or Forwarded', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(1) }); const { app, logs } = gateway(f);
    await request(app).get('/products').set('X-Forwarded-For', '192.0.2.1').expect(200);
    await request(app).get('/products').set('X-Forwarded-For', '192.0.2.2').set('X-Real-IP', '192.0.2.3').set('Forwarded', 'for=192.0.2.4').expect(429);
    expect(logs.every(log => log.identityType === 'ip')).toBe(true);
    expect(await redis.client.exists(bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', { type: 'ip', value: '127.0.0.1' }))).toBe(1);
    expect(await redis.client.exists(bucketKey(f.prefix, 'GLOBAL_ANONYMOUS', identity))).toBe(0);
  });
  it('trusted proxy forwarding distinguishes IPv4 and canonical IPv6 clients', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(1) }); const { app } = gateway(f, { trustedProxies: ['127.0.0.1/32'] });
    await request(app).get('/products').set('X-Forwarded-For', '192.0.2.1').expect(200);
    await request(app).get('/products').set('X-Forwarded-For', '192.0.2.2').expect(200);
    await request(app).get('/products').set('X-Forwarded-For', '2001:db8::1').expect(200);
    await request(app).get('/products').set('X-Forwarded-For', '2001:DB8:0:0:0:0:0:1').expect(429);
    await request(app).get('/products').set('X-Forwarded-For', '::ffff:192.0.2.1').expect(429);
  });
  it('stops at the nearest untrusted hop rather than using attacker-prepended addresses', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(1) }); const { app } = gateway(f, { trustedProxies: ['127.0.0.1'] });
    await request(app).get('/products').set('X-Forwarded-For', '198.51.100.1, 192.0.2.10').expect(200);
    await request(app).get('/products').set('X-Forwarded-For', '198.51.100.2, 192.0.2.10').expect(429);
  });
  it('rejects a malformed selected forwarding address before Redis and forwarding', async () => {
    const f = await fixture(); const { app, logs } = gateway(f, { trustedProxies: ['127.0.0.1'] });
    const response = await request(app).get('/products').set('X-Forwarded-For', 'malformed-address').expect(400);
    expect(response.body.error.code).toBe('INVALID_CLIENT_IP'); expect(target.seen).toHaveLength(0); expect(logs).toHaveLength(0);
    await request(app).get('/products').expect(200); // Missing forwarding data safely uses socket IP.
  });
  it('ignores malformed forwarding from an untrusted direct client', async () => {
    const f = await fixture(); await request(gateway(f).app).get('/products').set('X-Forwarded-For', 'bad').expect(200);
  });
  it('verified users share buckets across IPs; distinct users have independent capacity', async () => {
    const f = await fixture({ GLOBAL_AUTHENTICATED: slow(1), GLOBAL_ANONYMOUS: slow(10) });
    const { app, logs } = gateway(f, { trustedProxies: ['127.0.0.1'] }); const token = await jwt.sign('customer');
    await request(app).get('/products').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '192.0.2.1').expect(200);
    await request(app).get('/products').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', '192.0.2.2').expect(429);
    await request(app).get('/products').set('Authorization', `Bearer ${await jwt.sign('customer', { sub: randomUUID() })}`).expect(200);
    expect(logs[0]?.routePolicy).toBe('GLOBAL_AUTHENTICATED'); expect(logs[0]?.identityType).toBe('user');
  });
  it.each(['expiry', 'issuer', 'audience', 'signature', 'unsigned'])('invalid JWT %s cannot choose a user bucket', async kind => {
    const claimed = randomUUID(); const f = await fixture({ GLOBAL_ANONYMOUS: slow(1) }); const { app, logs } = gateway(f);
    const now = Math.floor(Date.now() / 1000);
    let token = await jwt.sign('customer', { sub: claimed, ...(kind === 'expiry' ? { exp: now - 100 } : {}),
      ...(kind === 'issuer' ? { iss: 'attacker' } : {}), ...(kind === 'audience' ? { aud: 'attacker' } : {}) });
    if (kind === 'signature') token = await (await createJwtFixture()).sign('customer', { sub: claimed });
    if (kind === 'unsigned') token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: claimed })).toString('base64url')}.`;
    await request(app).get('/products').set('Authorization', `Bearer ${token}`).set('X-User-Id', claimed).query({ userId: claimed }).expect(200);
    await request(app).get('/products').set('Authorization', `Bearer ${token}`).expect(429);
    expect(logs[0]?.identityType).toBe('ip');
    expect(await redis.client.exists(bucketKey(f.prefix, 'GLOBAL_AUTHENTICATED', { type: 'user', value: claimed }))).toBe(0);
  });
  it.each([['/auth/login', 'AUTH_LOGIN'], ['/AUTH/REGISTER/', 'AUTH_REGISTER']] as const)('throttles %s by IP even with valid changing JWTs', async (path, name) => {
    const f = await fixture({ [name]: slow(1) }); const { app, logs } = gateway(f);
    await request(app).post(path).set('Authorization', `Bearer ${await jwt.sign()}`).send({ email: 'one@example.test', password: 'SECRET' }).expect(200);
    await request(app).post(path).set('Authorization', `Bearer ${await jwt.sign('customer', { sub: randomUUID() })}`).send({ email: 'two@example.test' }).expect(429);
    expect(target.seen).toHaveLength(1); expect(logs[0]?.identityType).toBe('ip');
  });
  it.each([['/checkout', 'CHECKOUT_CREATE'], ['/checkout/id/retry', 'CHECKOUT_CREATE'], ['/orders/id/cancel', 'ORDER_CANCEL'], ['/payments/id/refunds', 'REFUND_CREATE'], ['/payments/id/reconcile', 'ADMIN_FINANCIAL']] as const)('applies stricter financial policy to %s and preserves retries', async (path, name) => {
    const f = await fixture({ [name]: slow(1) }); const { app } = gateway(f); const token = await jwt.sign();
    const raw = '{ "operation": "UNCHANGED" }'; const key = randomUUID();
    await request(app).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).set('Content-Type', 'application/json').send(raw).expect(200);
    await request(app).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(raw).expect(429);
    expect(target.seen).toHaveLength(1); expect(target.seen[0]).toMatchObject({ body: raw, key, authorization: `Bearer ${token}` });
    // Make one token legitimately available; retry forwards the original bytes and idempotency key.
    const bucket = bucketKey(f.prefix, name, { type: 'user', value: '00000000-0000-4000-8000-000000000000' });
    await seed(bucket, f.limiter.policies[name], 60_000, await redisTime());
    await request(app).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).set('Content-Type', 'application/json').send(raw).expect(200);
    expect(target.seen[1]).toMatchObject({ body: raw, key });
  });
  it('admin writes compose the administrator bucket across endpoint groups', async () => {
    const f = await fixture({ ADMIN_OPERATIONS: slow(1) }); const { app } = gateway(f); const token = await jwt.sign();
    await request(app).put('/inventory/id').set('Authorization', `Bearer ${token}`).send({}).expect(200);
    await request(app).post('/products').set('Authorization', `Bearer ${token}`).send({}).expect(429);
  });
  it.each([401, 403, 409])('preserves downstream status %i with protection enabled', async status => {
    const f = await fixture(); const { app } = gateway(f); target.behavior.status = status;
    const token = status === 401 ? 'invalid' : await jwt.sign();
    const response = await request(app).post('/payments/id/refunds').set('Authorization', `Bearer ${token}`).send({}).expect(status);
    expect(response.body).toEqual({ forwarded: true }); expect(target.seen).toHaveLength(1);
    expect(target.seen[0]?.authorization).toBe(`Bearer ${token}`);
  });
  it('has no header-only internal exemption and does not publicly route internal service lookups', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(1) }); const { app } = gateway(f);
    await request(app).get('/products').set('X-Internal-Service', 'orders').expect(200);
    await request(app).get('/products').set('X-Internal-Service', 'notifications').set('X-Service-Signature', 'forged').expect(429);
    await request(app).get('/internal/users/id/contact').set('X-Internal-Service', 'notifications').expect(404);
    expect(target.seen).toHaveLength(1);
  });
  it('logs only safe fields, and responses contain no keys, hashes, tokens, user IDs or passwords', async () => {
    const f = await fixture({ CHECKOUT_CREATE: slow(1) }); const { app, logs, metrics } = gateway(f);
    const subject = randomUUID(), token = await jwt.sign('customer', { sub: subject });
    await request(app).post('/checkout').set('Authorization', `Bearer ${token}`).send({ password: 'PRIVATE_PASSWORD' }).expect(200);
    const denied = await request(app).post('/checkout').set('Authorization', `Bearer ${token}`).expect(429);
    const serialized = JSON.stringify({ logs, metrics: metrics.snapshot(), body: denied.body, headers: denied.headers });
    for (const value of [subject, token, 'PRIVATE_PASSWORD', f.prefix, bucketKey(f.prefix, 'CHECKOUT_CREATE', { type: 'user', value: subject })]) expect(serialized).not.toContain(value);
    expect(logs[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(logs[0]?.redisDurationMs).toBeGreaterThanOrEqual(0);
  });
});
describe('Redis outages, recovery and bounded lifecycle', () => {
  it('does not wait indefinitely at unavailable startup and recovers when Redis appears', async () => {
    const proxy = await redisProxy(redis.port); cleanup.push(() => proxy.close()); await proxy.disconnect();
    const store = new RedisRateLimitStore({ url: proxy.url, connectTimeoutMs: 100, commandTimeoutMs: 100, maxPending: 10 });
    cleanup.push(() => store.close()); const start = performance.now(); expect(await store.start()).toBe(false);
    expect(performance.now() - start).toBeLessThan(500); expect(store.ready).toBe(false);
    const f = { store, prefix: `ecommerce:v2:ratelimit:v1:test-${randomUUID()}`, limiter: new DistributedRateLimiter(store) };
    const { app } = gateway(f); await request(app).get('/health').expect(200); await request(app).get('/ready').expect(503);
    await request(app).get('/products').expect(200); await request(app).post('/auth/login').send({}).expect(503);
    await proxy.recover(); await ready(store); await request(app).get('/ready').expect(200);
    await request(app).post('/auth/login').send({}).expect(200);
  });
  it('bounds a connected but stalled Redis handshake and recovers without blocking startup', async () => {
    const proxy = await redisProxy(redis.port); cleanup.push(() => proxy.close()); proxy.pause();
    const store = new RedisRateLimitStore({ url: proxy.url, connectTimeoutMs: 100, commandTimeoutMs: 100, maxPending: 10 });
    cleanup.push(() => store.close());
    const start = performance.now(); expect(await store.start()).toBe(false);
    expect(performance.now() - start).toBeLessThan(500); await proxy.captured();
    proxy.release(); await ready(store); expect(store.ready).toBe(true);
  });
  it('disconnects during an in-flight request, returns 503, and preserves shared burst limits after recovery', async () => {
    const proxy = await redisProxy(redis.port); cleanup.push(() => proxy.close());
    const f = await fixture({ AUTH_LOGIN: slow(5) }, 100, 100, proxy.url); const { app } = gateway(f);
    proxy.pause(); const pending = request(app).post('/auth/login').send({}).then(r => r);
    await proxy.captured(); await proxy.disconnect(); const response = await pending;
    expect(response.status).toBe(503); expect(response.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
    const outage = await request(app).get('/products').expect(200); expect(outage.headers['ratelimit-limit']).toBeUndefined();
    await proxy.recover(); proxy.release(); await ready(f.store);
    const results = await Promise.all(Array.from({ length: 20 }, () => request(app).post('/auth/login').send({})));
    // The lost reply's command executed on Redis before disconnect: it must never be retried automatically.
    expect(results.filter(r => r.status === 200)).toHaveLength(4); expect(results.filter(r => r.status === 429)).toHaveLength(16);
  });
  it('bounds slow-command latency, uses 503 instead of 429, and recovers without replaying', async () => {
    const proxy = await redisProxy(redis.port); cleanup.push(() => proxy.close());
    const f = await fixture({ AUTH_LOGIN: slow(1) }, 80, 10, proxy.url); const { app, logs } = gateway(f);
    proxy.pause(); const start = performance.now(); const pending = request(app).post('/auth/login').send({}).then(r => r);
    await proxy.captured(); const response = await pending;
    expect(response.status).toBe(503); expect(performance.now() - start).toBeLessThan(500);
    expect(logs[0]?.redisErrorCode).toBe('TIMEOUT'); proxy.release(); await ready(f.store);
    await request(app).post('/auth/login').send({}).expect(429);
  });
  it('bounds pending commands under a stalled socket', async () => {
    const proxy = await redisProxy(redis.port); cleanup.push(() => proxy.close());
    const f = await fixture({}, 200, 1, proxy.url); proxy.pause();
    const first = f.limiter.decide(['GLOBAL_ANONYMOUS'], identity).catch(error => error);
    await proxy.captured(); await expect(f.limiter.decide(['GLOBAL_ANONYMOUS'], identity)).rejects.toMatchObject({ code: 'SATURATED' });
    proxy.release(); expect((await first).allowed).toBe(true);
  });
  it('shutdown cancels a pending command and reconnects, completes promptly and rejects subsequent commands', async () => {
    const proxy = await redisProxy(redis.port); cleanup.push(() => proxy.close());
    const f = await fixture({}, 1000, 10, proxy.url); proxy.pause();
    const pending = f.limiter.decide(['GLOBAL_ANONYMOUS'], identity).catch(error => error); await proxy.captured();
    const start = performance.now(); await f.store.close(); expect(performance.now() - start).toBeLessThan(500);
    expect((await pending).code).toBe('CLOSED'); expect(f.store.ready).toBe(false);
    await expect(f.limiter.decide(['GLOBAL_ANONYMOUS'], identity)).rejects.toMatchObject({ code: 'CLOSED' });
    expect(await f.store.start()).toBe(false);
  });
  it('health and readiness are unthrottled and the disabled Gateway never connects to Redis', async () => {
    const f = await fixture({ GLOBAL_ANONYMOUS: slow(1) }); const { app } = gateway(f);
    await request(app).get('/products').expect(200); await request(app).get('/products').expect(429);
    await request(app).get('/health').expect(200); await request(app).get('/ready').expect(200);
    const disabled = createApp({ CATALOG_SERVICE_URL: target.url, CATALOG_REQUEST_TIMEOUT_MS: 1000 });
    expect((await request(disabled).get('/ready').expect(200)).body.rateLimiting).toBe('disabled');
    expect((await request(disabled).get('/products').expect(200)).headers['ratelimit-limit']).toBeUndefined();
  });
});


describe('Node 24 Gateway process lifecycle', () => {
  it('starts degraded during outage, recovers after startup and exits cleanly on SIGTERM', async () => {
    const proxy = await redisProxy(redis.port); cleanup.push(() => proxy.close()); await proxy.disconnect();
    const process = await gatewayProcess(proxy.url, target.url, jwt.publicPem); cleanup.push(() => process.close());
    await process.waitFor('/health', 200);
    expect((await fetch(process.url + '/ready')).status).toBe(503);
    expect((await fetch(process.url + '/products')).status).toBe(200);
    expect((await fetch(process.url + '/auth/login', { method: 'POST' })).status).toBe(503);
    await proxy.recover(); await process.waitFor('/ready', 200);
    expect((await fetch(process.url + '/auth/login', { method: 'POST' })).status).toBe(200);
    process.child.kill('SIGTERM'); expect(await process.exit, process.output()).toEqual({ code: 0, signal: null });
    expect(process.output()).toContain('startup_degraded');
  }, 15_000);
  it('drains an in-flight slow Redis decision within the command deadline during shutdown', async () => {
    const proxy = await redisProxy(redis.port); cleanup.push(() => proxy.close());
    const process = await gatewayProcess(proxy.url, target.url, jwt.publicPem); cleanup.push(() => process.close());
    await process.waitFor('/ready', 200); proxy.pause();
    const pending = fetch(process.url + '/auth/login', { method: 'POST', signal: AbortSignal.timeout(5000) }); await proxy.captured();
    const start = performance.now(); process.child.kill('SIGTERM');
    expect((await pending).status).toBe(503);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([process.exit, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Process did not exit: ${process.output()}`)), 3000);
      })]);
      expect(exit, process.output()).toEqual({ code: 0, signal: null });
    } finally { clearTimeout(timer); }
    expect(performance.now() - start).toBeLessThan(1500);
  }, 15_000);
});
