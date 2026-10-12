import { loadInventoryEnvironment } from '@ecommerce/config';
import { createApp } from './app.js';
import { createPool, verifyDatabaseBoundary } from './db/pool.js';
import { readFile } from 'node:fs/promises';
import { InventoryRepository } from './inventory-repository.js';
import { InventoryService } from './inventory-service.js';
import { CatalogClient } from './catalog-client.js';
import { startExpirationWorker } from './expiration-worker.js';
import { createTokenVerifier } from '@ecommerce/security';

const environment = loadInventoryEnvironment();
const verify = await createTokenVerifier(await readFile(environment.JWT_PUBLIC_KEY_FILE, 'utf8'), {
  issuer: environment.JWT_ISSUER, audience: environment.JWT_AUDIENCE,
});
const pool = createPool(environment);
let inventory: InventoryService;
const repository = new InventoryRepository(pool, environment.RESERVATION_TTL_SECONDS);
try {
  await verifyDatabaseBoundary(pool);
  inventory = new InventoryService(repository, new CatalogClient(environment.CATALOG_SERVICE_URL, environment.CATALOG_REQUEST_TIMEOUT_MS));
} catch {
  await pool.end();
  throw new Error('Inventory startup failed; check database readiness and dedicated role permissions');
}
const worker = startExpirationWorker(repository, environment.EXPIRATION_WORKER_INTERVAL_MS, environment.EXPIRATION_WORKER_BATCH_SIZE);
const server = createApp(inventory, verify).listen(environment.INVENTORY_PORT, environment.INVENTORY_HOST, () => {
  console.info(`Inventory Service listening on http://${environment.INVENTORY_HOST}:${environment.INVENTORY_PORT}`);
});

server.on('error', (error: Error) => {
  console.error('Inventory Service server error:', error);
  process.exitCode = 1;
  void worker.stop().then(() => pool.end());
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing Inventory Service`);

  const deadline = setTimeout(() => {
    console.error('Graceful shutdown deadline exceeded');
    server.closeAllConnections();
    process.exit(1);
  }, environment.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  const workerStopped = worker.stop();
  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    if (error) {
      console.error('Inventory Service shutdown failed:', error);
      process.exitCode = 1;
    }
    try { await workerStopped; await pool.end(); }
    catch { console.error('Inventory pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
