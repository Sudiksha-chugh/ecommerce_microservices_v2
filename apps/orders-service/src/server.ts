import { loadOrdersEnvironment } from '@ecommerce/config';
import { createApp } from './app.js';
import { createPool, verifyDatabaseBoundary } from './db/pool.js';
import { readFile } from 'node:fs/promises';
import { OrderRepository } from './order-repository.js';
import { OrderService } from './order-service.js';
import { CartClient, CatalogClient } from './http-clients.js';
import { createTokenVerifier } from '@ecommerce/security';

const environment = loadOrdersEnvironment();
const verify = await createTokenVerifier(await readFile(environment.JWT_PUBLIC_KEY_FILE, 'utf8'), {
  issuer: environment.JWT_ISSUER, audience: environment.JWT_AUDIENCE,
});
const pool = createPool(environment);
let orders: OrderService;
try {
  await verifyDatabaseBoundary(pool);
  orders = new OrderService(new OrderRepository(pool),
    new CartClient(environment.CART_SERVICE_URL, environment.CART_REQUEST_TIMEOUT_MS),
    new CatalogClient(environment.CATALOG_SERVICE_URL, environment.CATALOG_REQUEST_TIMEOUT_MS));
} catch {
  await pool.end();
  throw new Error('Orders startup failed; check database readiness and dedicated role permissions');
}
const server = createApp(orders, verify).listen(environment.ORDERS_PORT, environment.ORDERS_HOST, () => {
  console.info(`Orders Service listening on http://${environment.ORDERS_HOST}:${environment.ORDERS_PORT}`);
});

server.on('error', (error: Error) => {
  console.error('Orders Service server error:', error);
  process.exitCode = 1;
  void pool.end();
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing Orders Service`);

  const deadline = setTimeout(() => {
    console.error('Graceful shutdown deadline exceeded');
    server.closeAllConnections();
    process.exit(1);
  }, environment.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    if (error) {
      console.error('Orders Service shutdown failed:', error);
      process.exitCode = 1;
    }
    try { await pool.end(); }
    catch { console.error('Orders pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
