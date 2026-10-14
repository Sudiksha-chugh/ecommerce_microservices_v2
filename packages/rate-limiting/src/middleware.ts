import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import { InvalidTokenError, type Identity, type TokenVerifier } from '@ecommerce/security';
import { extractIdentity } from './identity.js';
import { selectRoutePolicies } from './policies.js';
import { RateLimitStoreError } from './errors.js';
import { RateLimitMetrics, type DecisionKind } from './metrics.js';
import type { DistributedRateLimiter } from './limiter.js';
export interface DecisionLog {
  requestId: string; routePolicy: string; identityType: 'ip' | 'user'; decision: DecisionKind;
  retryAfterMs: number; redisDurationMs: number; failureMode: 'open' | 'closed'; redisErrorCode?: string;
}
export interface ProtectionOptions {
  limiter: DistributedRateLimiter; verify: TokenVerifier; trustedProxies: string[]; failOpenPublic: boolean;
  metrics?: RateLimitMetrics; log?: (record: DecisionLog) => void;
}
export function rateLimitMiddleware(options: ProtectionOptions): RequestHandler {
  const metrics = options.metrics ?? new RateLimitMetrics();
  const sink = options.log ?? (record => {
    const output = JSON.stringify({ component: 'rate-limiting', ...record });
    if (record.decision.startsWith('fail_')) console.warn(output); else console.info(output);
  });
  // An observability sink failure must not change an already atomic admission decision.
  const log = (record: DecisionLog) => { try { sink(record); } catch { /* No sensitive fallback exception log. */ } };
  return async (req, res, next) => {
    let verified: Identity | undefined;
    const initial = selectRoutePolicies(req.method, req.path, false, false);
    if (req.headers.authorization && !initial.forceIp) {
      try { verified = await options.verify(req.headers.authorization); }
      catch (error) { if (!(error instanceof InvalidTokenError)) { next(error); return; } }
    }
    const route = selectRoutePolicies(req.method, req.path, !!verified, verified?.role === 'admin');
    let identity;
    try { identity = extractIdentity(req.ip ?? '', verified, route.forceIp); }
    catch { res.status(400).json({ error: { code: 'INVALID_CLIENT_IP', message: 'Invalid client address' } }); return; }
    const failureMode: 'open' | 'closed' = route.publicRead && options.failOpenPublic ? 'open' : 'closed';
    const start = performance.now();
    const base = { requestId: String(res.locals.requestId), identityType: identity.type, failureMode };
    try {
      const decision = await options.limiter.decide(route.names, identity);
      const kind = decision.allowed ? 'allowed' : 'denied';
      metrics.observe(decision.policy, kind, decision.redisDurationMs);
      log({ ...base, routePolicy: decision.policy, decision: kind, retryAfterMs: decision.retryAfterMs, redisDurationMs: decision.redisDurationMs });
      res.set({ 'RateLimit-Limit': String(decision.capacity), 'RateLimit-Remaining': String(decision.remaining),
        'RateLimit-Reset': String(Math.ceil(decision.resetMs / 1000)) });
      if (decision.allowed) { next(); return; }
      res.set({ 'Retry-After': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))), 'Cache-Control': 'no-store' });
      res.status(429).json({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Try again later.' } });
    } catch (error) {
      const decision = failureMode === 'open' ? 'fail_open' : 'fail_closed';
      const duration = performance.now() - start;
      const policy = route.names.at(-1)!;
      metrics.observe(policy, decision, duration);
      log({ ...base, routePolicy: policy, decision, retryAfterMs: 0, redisDurationMs: duration,
        redisErrorCode: error instanceof RateLimitStoreError ? error.code : 'UNAVAILABLE' });
      if (failureMode === 'open') { next(); return; }
      res.set('Cache-Control', 'no-store');
      res.status(503).json({ error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'Request protection temporarily unavailable. Try again later.' } });
    }
  };
}
