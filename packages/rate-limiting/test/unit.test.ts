import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { bucketKey, normalizeIp, createProxyTrust, extractIdentity, loadRateLimitEnvironment, selectRoutePolicies,
  DistributedRateLimiter, rateLimitMiddleware, RateLimitStoreError, RateLimitMetrics, parsePolicyOverrides,
  type DecisionStore, type DecisionLog } from '../src/index.js';
import { InvalidTokenError } from '@ecommerce/security';

const anonymous = { type: 'ip' as const, value: '127.0.0.1' };
describe('identity and deployment configuration', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'], ['::ffff:192.0.2.1', '192.0.2.1'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8:0:0:0:0:0:1'], ['2001:db8::1', '2001:db8:0:0:0:0:0:1'],
  ])('normalizes %s', (input, output) => expect(normalizeIp(input)).toBe(output));
  it.each(['unknown', '127.1', '192.0.2.1:8000', '[::1]', 'fe80::1%en0', ''])('rejects malformed IP %s', value => expect(() => normalizeIp(value)).toThrow());
  it('hashes type-separated identities consistently without exposing the IP or user', () => {
    const prefix = 'ecommerce:v2:ratelimit:v1';
    const key = bucketKey(prefix, 'GLOBAL_ANONYMOUS', anonymous);
    expect(key).toMatch(/^ecommerce:v2:ratelimit:v1:GLOBAL_ANONYMOUS:[a-f0-9]{64}$/);
    expect(key).not.toContain(anonymous.value);
    expect(key).toBe(bucketKey(prefix, 'GLOBAL_ANONYMOUS', anonymous));
    expect(key).not.toBe(bucketKey(prefix, 'GLOBAL_ANONYMOUS', { type: 'user', value: anonymous.value }));
  });
  it('uses a verified subject unless an authentication endpoint forces IP', () => {
    const identity = { id: 'verified-subject', role: 'customer' as const };
    expect(extractIdentity('::ffff:127.0.0.1', identity)).toEqual({ type: 'user', value: identity.id });
    expect(extractIdentity('::ffff:127.0.0.1', identity, true)).toEqual(anonymous);
  });
  it('trusts only configured addresses and same-family CIDRs', () => {
    const trust = createProxyTrust(['127.0.0.1', '10.0.0.0/24', '2001:db8::/64']);
    expect(trust('::ffff:127.0.0.1')).toBe(true); expect(trust('10.0.0.12')).toBe(true);
    expect(trust('10.0.1.12')).toBe(false); expect(trust('2001:db8::9')).toBe(true);
    expect(trust('2001:db9::9')).toBe(false); expect(trust('bad')).toBe(false);
    expect(createProxyTrust([])('127.0.0.1')).toBe(false);
  });
  it.each(['true', '0.0.0.0/0', '::/0', '127.0.0.1/33', '::1/129', '127.0.0.1/no', 'host.example'])('rejects unsafe proxy config %s', proxy => {
    expect(() => loadRateLimitEnvironment({ RATE_LIMIT_TRUSTED_PROXIES: proxy })).toThrow('Invalid rate-limit configuration');
  });
  it('is opt-in and bounds connection/command queues', () => {
    const config = loadRateLimitEnvironment({});
    expect(config.RATE_LIMIT_ENABLED).toBe(false); expect(config.trustedProxies).toEqual([]);
    expect(config.RATE_LIMIT_REDIS_URL).toBe('redis://127.0.0.1:6380/0');
    expect(() => loadRateLimitEnvironment({ RATE_LIMIT_ENABLED: 'true' })).toThrow();
    expect(() => loadRateLimitEnvironment({ RATE_LIMIT_MAX_PENDING: '0' })).toThrow();
    expect(() => loadRateLimitEnvironment({ RATE_LIMIT_COMMAND_TIMEOUT_MS: '999999' })).toThrow();
  });
  it('validates overrides and prevents unbounded TTLs/unknown policies/key collisions', () => {
    expect(parsePolicyOverrides('{"AUTH_LOGIN":{"capacity":8,"refillTokens":5,"windowMs":60000}}').AUTH_LOGIN?.capacity).toBe(8);
    expect(() => parsePolicyOverrides('{"NOT_A_POLICY":{"capacity":1,"refillTokens":1,"windowMs":1000}}')).toThrow();
    expect(() => parsePolicyOverrides('{"AUTH_LOGIN":{"capacity":1000000,"refillTokens":1,"windowMs":3600000}}')).toThrow();
    expect(() => loadRateLimitEnvironment({ RATE_LIMIT_KEY_PREFIX: 'cart' })).toThrow();
    expect(() => loadRateLimitEnvironment({ RATE_LIMIT_REDIS_URL: 'http://localhost' })).toThrow();
    expect(() => loadRateLimitEnvironment({ RATE_LIMIT_ENABLED: 'yes' })).toThrow();
  });
});
describe('existing route policy composition', () => {
  it.each([
    ['POST', '/auth/login', false, false, ['GLOBAL_ANONYMOUS', 'AUTH_LOGIN']],
    ['POST', '/AUTH/REGISTER/', true, true, ['GLOBAL_ANONYMOUS', 'AUTH_REGISTER']],
    ['POST', '/checkout', true, false, ['GLOBAL_AUTHENTICATED', 'CHECKOUT_CREATE']],
    ['POST', '/checkout/id/retry', true, false, ['GLOBAL_AUTHENTICATED', 'CHECKOUT_CREATE']],
    ['POST', '/orders/id/cancel', true, false, ['GLOBAL_AUTHENTICATED', 'ORDER_CANCEL']],
    ['POST', '/payments/id/refunds', true, true, ['GLOBAL_AUTHENTICATED', 'REFUND_CREATE', 'ADMIN_OPERATIONS']],
    ['POST', '/payments/refunds/id/reconcile', true, true, ['GLOBAL_AUTHENTICATED', 'ADMIN_FINANCIAL', 'ADMIN_OPERATIONS']],
    ['PUT', '/inventory/id', true, true, ['GLOBAL_AUTHENTICATED', 'ADMIN_OPERATIONS']],
    ['GET', '/products', false, false, ['GLOBAL_ANONYMOUS']],
    ['GET', '/orders', true, false, ['GLOBAL_AUTHENTICATED']],
  ] as const)('selects %s %s', (method, path, authenticated, admin, expected) => expect(selectRoutePolicies(method, path, authenticated, admin).names).toEqual(expected));
  it('identifies public reads and keeps protected reads closed', () => {
    expect(selectRoutePolicies('HEAD', '/products/id/', false, false).publicRead).toBe(true);
    expect(selectRoutePolicies('GET', '/inventory/id', false, false).publicRead).toBe(true);
    expect(selectRoutePolicies('POST', '/products', false, false).publicRead).toBe(false);
    expect(selectRoutePolicies('GET', '/cart', true, false).publicRead).toBe(false);
  });
});
function appFixture(store: DecisionStore, failOpenPublic = true, throwingLog = false) {
  const logs: DecisionLog[] = []; const metrics = new RateLimitMetrics();
  const app = express(); app.use((_req, res, next) => { res.locals.requestId = 'test-request'; next(); });
  app.use(rateLimitMiddleware({ limiter: new DistributedRateLimiter(store), verify: async () => { throw new InvalidTokenError(); },
    trustedProxies: [], failOpenPublic, metrics, log: record => { if (throwingLog) throw new Error('Log sink unavailable'); logs.push(record); } }));
  app.use((_req, res) => res.json({ forwarded: true }));
  return { app, logs, metrics };
}
describe('HTTP decisions and observability', () => {
  it('formats 429 and constraining headers without internal keys', async () => {
    const store: DecisionStore = { ready: true, decide: async () => ({ allowed: false, buckets: [
      { remaining: 20, retryAfterMs: 0, resetMs: 2000 }, { remaining: 0, retryAfterMs: 12_001, resetMs: 60_000 },
    ] }) };
    const { app, logs, metrics } = appFixture(store);
    const response = await request(app).post('/auth/login').expect(429);
    expect(response.body).toEqual({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Try again later.' } });
    expect(response.headers['retry-after']).toBe('13'); expect(response.headers['ratelimit-limit']).toBe('5');
    expect(response.headers['ratelimit-remaining']).toBe('0'); expect(response.headers['ratelimit-reset']).toBe('60');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(logs[0]?.routePolicy).toBe('AUTH_LOGIN'); expect(logs[0]?.requestId).toBe('test-request');
    expect(metrics.snapshot().counters['rate_limit_denied_total:AUTH_LOGIN']).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain('ecommerce');
  });
  it('reports the smallest relative remaining capacity on allowed composed decisions', async () => {
    const store: DecisionStore = { ready: true, decide: async () => ({ allowed: true, buckets: [
      { remaining: 90, retryAfterMs: 0, resetMs: 2000 }, { remaining: 1, retryAfterMs: 0, resetMs: 40_000 },
    ] }) };
    const { app, metrics } = appFixture(store);
    const response = await request(app).post('/auth/login').expect(200);
    expect(response.headers['ratelimit-limit']).toBe('5'); expect(response.headers['ratelimit-remaining']).toBe('1');
    expect(metrics.snapshot().counters['rate_limit_allowed_total:AUTH_LOGIN']).toBe(1);
  });
  it.each(['/auth/login', '/auth/register', '/checkout', '/orders/id/cancel', '/payments/id/refunds', '/payments/id/process'])('fails closed with 503 for %s', async path => {
    const { app, logs, metrics } = appFixture({ ready: false, decide: async () => { throw new RateLimitStoreError('TIMEOUT'); } });
    const response = await request(app).post(path).send({ password: 'DO_NOT_LOG' }).expect(503);
    expect(response.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE'); expect(response.headers['retry-after']).toBeUndefined();
    expect(response.headers['ratelimit-limit']).toBeUndefined(); expect(logs[0]?.decision).toBe('fail_closed');
    expect(logs[0]?.redisErrorCode).toBe('TIMEOUT'); expect(JSON.stringify(logs)).not.toContain('DO_NOT_LOG');
    expect(Object.keys(metrics.snapshot().counters)).toHaveLength(2);
  });
  it('fails open for public reads with a structured event and no false quota headers', async () => {
    const { app, logs, metrics } = appFixture({ ready: false, decide: async () => { throw new Error('secret-url'); } });
    const response = await request(app).get('/products').expect(200);
    expect(response.headers['ratelimit-limit']).toBeUndefined(); expect(logs[0]?.decision).toBe('fail_open');
    expect(JSON.stringify(logs)).not.toContain('secret-url');
    expect(metrics.snapshot().counters['rate_limit_fail_open_total:GLOBAL_ANONYMOUS']).toBe(1);
    expect(metrics.snapshot().counters['rate_limit_redis_errors_total:GLOBAL_ANONYMOUS']).toBe(1);
    expect(metrics.snapshot().rate_limit_decision_duration_ms.GLOBAL_ANONYMOUS?.count).toBe(1);
  });
  it('preserves admission when the log sink throws', async () => {
    const { app } = appFixture({ ready: true, decide: async () => ({ allowed: true, buckets: [
      { remaining: 99, retryAfterMs: 0, resetMs: 1000 },
    ] }) }, true, true);
    await request(app).get('/products').expect(200);
  });
  it('allows operators to close public reads during Redis failure', async () => {
    const { app } = appFixture({ ready: false, decide: async () => { throw new RateLimitStoreError('UNAVAILABLE'); } }, false);
    await request(app).get('/products').expect(503);
  });
});
