import { loadGatewayEnvironment } from '@ecommerce/config';
import { createApp } from './app.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import { createTokenVerifier } from '@ecommerce/security';
import { loadRateLimitEnvironment, RedisRateLimitStore, DistributedRateLimiter, RateLimitMetrics } from '@ecommerce/rate-limiting';

const environment = loadGatewayEnvironment();
const rateConfig = loadRateLimitEnvironment();
const store = rateConfig.RATE_LIMIT_ENABLED ? new RedisRateLimitStore({
  url: rateConfig.RATE_LIMIT_REDIS_URL, connectTimeoutMs: rateConfig.RATE_LIMIT_CONNECT_TIMEOUT_MS,
  commandTimeoutMs: rateConfig.RATE_LIMIT_COMMAND_TIMEOUT_MS, maxPending: rateConfig.RATE_LIMIT_MAX_PENDING,
}) : undefined;
const protection = store ? {
  limiter: new DistributedRateLimiter(store, rateConfig.RATE_LIMIT_KEY_PREFIX, rateConfig.policies),
  verify: await createTokenVerifier(await readFile(rateConfig.JWT_PUBLIC_KEY_FILE!, 'utf8'), {
    issuer: rateConfig.JWT_ISSUER!, audience: rateConfig.JWT_AUDIENCE!,
  }), trustedProxies: rateConfig.trustedProxies, failOpenPublic: rateConfig.RATE_LIMIT_FAIL_OPEN_PUBLIC,
  metrics: new RateLimitMetrics(),
} : undefined;
if (store && !await store.start()) console.warn(JSON.stringify({ component: 'rate-limiting', decision: 'startup_degraded' }));
const searchSettings=z.object({SEARCH_ENABLED:z.enum(['true','false']).default('false'),SEARCH_SERVICE_URL:z.url().refine(v=>{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash;}).default('http://127.0.0.1:4008'),SEARCH_GATEWAY_TIMEOUT_MS:z.coerce.number().int().min(20).max(15000).default(5000)}).parse(process.env);
const app = createApp(environment, protection,{enabled:searchSettings.SEARCH_ENABLED==='true',url:searchSettings.SEARCH_SERVICE_URL,timeoutMs:searchSettings.SEARCH_GATEWAY_TIMEOUT_MS});
const server = app.listen(environment.PORT, environment.HOST, () => {
  console.info(`API Gateway listening on http://${environment.HOST}:${environment.PORT}`);
});

server.on('error', (error: Error) => {
  console.error('API Gateway server error:', error);
  void store?.close();
  process.exitCode = 1;
});

const activeResponses = new Set<ServerResponse>();
server.on('request', (_req, response) => {
  activeResponses.add(response);
  response.once('finish', () => activeResponses.delete(response));
  response.once('close', () => activeResponses.delete(response));
});
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // In-flight replies that finish after server.close must not leave keep-alive sockets behind.
  for (const response of activeResponses) {
    response.shouldKeepAlive = false;
    if (!response.headersSent) response.setHeader('Connection', 'close');
  }
  console.info(`${signal} received; closing API Gateway`);

  const deadline = setTimeout(() => {
    console.error('Graceful shutdown deadline exceeded');
    server.closeAllConnections();
    void store?.close();
    process.exit(1);
  }, environment.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    await store?.close();
    clearTimeout(deadline);
    if (error) {
      console.error('API Gateway shutdown failed:', error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
