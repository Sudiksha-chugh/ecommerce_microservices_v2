import { readFile } from 'node:fs/promises';
import { loadCartEnvironment } from '@ecommerce/config';
import { createTokenVerifier } from '@ecommerce/security';
import { createApp } from './app.js';
import { createRedisClient, connectRedis } from './redis/client.js';
import { CartRepository } from './cart-repository.js';
import { CatalogClient } from './catalog-client.js';
import { CartService } from './cart-service.js';

const environment = loadCartEnvironment();
const verify = await createTokenVerifier(await readFile(environment.JWT_PUBLIC_KEY_FILE, 'utf8'), {
  issuer: environment.JWT_ISSUER, audience: environment.JWT_AUDIENCE,
});
const redis = createRedisClient(environment.CART_REDIS_URL, environment.CART_REDIS_CONNECT_TIMEOUT_MS);
await connectRedis(redis, environment.CART_REDIS_CONNECT_TIMEOUT_MS);
const carts = new CartRepository(redis, environment.CART_TTL_SECONDS, environment.CART_REDIS_COMMAND_TIMEOUT_MS);
const cart = new CartService(carts, new CatalogClient(environment.CATALOG_SERVICE_URL, environment.CATALOG_REQUEST_TIMEOUT_MS));
const server = createApp(cart, verify).listen(environment.CART_PORT, environment.CART_HOST, () => {
  console.info(`Cart Service listening on http://${environment.CART_HOST}:${environment.CART_PORT}`);
});
server.on('error', () => {
  console.error('Cart Service server error');
  redis.destroy(); process.exitCode = 1;
});
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing Cart Service`);
  const deadline = setTimeout(() => {
    console.error('Graceful shutdown deadline exceeded');
    server.closeAllConnections(); redis.destroy(); process.exit(1);
  }, environment.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();
  server.close(async (error) => {
    if (error) process.exitCode = 1;
    try { if (redis.isOpen) await redis.close(); }
    catch { console.error('Cart Redis shutdown failed'); redis.destroy(); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
