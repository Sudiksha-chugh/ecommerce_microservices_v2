import {compensationHandler} from './compensation-consumer.js';
import {inventoryCheckoutHandler} from './checkout-consumer.js';
import {sagaKeys} from '@ecommerce/messaging';
import {OutboxWorker,OutboxRepository,pollWorker} from '@ecommerce/event-persistence';
import { receiptHandlers } from '@ecommerce/event-persistence';
import { bootstrapMessaging } from '@ecommerce/messaging';
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
const checkoutEnabled=process.env.CHECKOUT_SAGA_ENABLED==='true';
if(checkoutEnabled && (process.env.MESSAGING_ENABLED!=='true'||process.env.MESSAGING_DIAGNOSTIC_CONSUMERS==='true'))throw new Error('Checkout requires messaging with diagnostics disabled');
const refundsEnabled=process.env.REFUNDS_ENABLED==='true';
if(refundsEnabled && (process.env.MESSAGING_ENABLED!=='true'||process.env.MESSAGING_DIAGNOSTIC_CONSUMERS==='true'))throw new Error('Refunds require messaging with diagnostics disabled');
const keys=checkoutEnabled||refundsEnabled?sagaKeys():undefined;
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
const messaging = bootstrapMessaging('inventory', process.env, {...receiptHandlers(pool,'inventory'),...(checkoutEnabled&&keys?{'inventory.checkout-commands.v1':inventoryCheckoutHandler(pool,repository,keys,undefined,refundsEnabled)}:{}),...(refundsEnabled&&keys?{'inventory.compensation-commands.v1':compensationHandler(pool,repository,keys)}:{})});
const checkoutOutbox=keys?new OutboxWorker(new OutboxRepository(pool),messaging):undefined;
checkoutOutbox?.start();
const server = createApp(inventory, verify, messaging.readiness).listen(environment.INVENTORY_PORT, environment.INVENTORY_HOST, () => {
  console.info(`Inventory Service listening on http://${environment.INVENTORY_HOST}:${environment.INVENTORY_PORT}`);
});

server.on('error', (error: Error) => {
  console.error('Inventory Service server error:', error);
  process.exitCode = 1;
  void Promise.all([worker.stop(),checkoutOutbox?.stop(),messaging.stop()]).then(() => pool.end());
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
  const messagingStopped = Promise.all([checkoutOutbox?.stop(),]).then(()=>messaging.stop());
  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    if (error) {
      console.error('Inventory Service shutdown failed:', error);
      process.exitCode = 1;
    }
    try { await Promise.all([workerStopped, messagingStopped]); await pool.end(); }
    catch { console.error('Inventory pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
