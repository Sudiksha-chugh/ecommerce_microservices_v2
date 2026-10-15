import {orderNotificationContext} from './notification-context.js';
import {SagaRepository} from './saga/repository.js';
import {sagaKeys} from '@ecommerce/messaging';
import {OutboxWorker,OutboxRepository,pollWorker} from '@ecommerce/event-persistence';
import { bootstrapMessaging } from '@ecommerce/messaging';
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
const checkoutEnabled=process.env.CHECKOUT_SAGA_ENABLED==='true';
if(checkoutEnabled && (process.env.MESSAGING_ENABLED!=='true'||process.env.MESSAGING_DIAGNOSTIC_CONSUMERS==='true'))throw new Error('Checkout requires messaging with diagnostics disabled');
const refundsEnabled=process.env.REFUNDS_ENABLED==='true';
if(refundsEnabled && (process.env.MESSAGING_ENABLED!=='true'||process.env.MESSAGING_DIAGNOSTIC_CONSUMERS==='true'))throw new Error('Refunds require messaging with diagnostics disabled');
const keys=checkoutEnabled||refundsEnabled?sagaKeys():undefined;
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
const saga=checkoutEnabled&&keys?new SagaRepository(pool,keys,undefined,refundsEnabled):undefined;
const messaging = bootstrapMessaging('orders',process.env,saga?{'orders.checkout-events.v1':saga.handler,...(refundsEnabled?{'orders.refund-events.v1':saga.refundHandler}:{})}:{});
const sagaWorker=saga?pollWorker(async()=>{await saga.recover();console.info(JSON.stringify({component:'checkout-metrics',states:await saga.stats()}));},5000):undefined;
const checkoutOutbox=keys?new OutboxWorker(new OutboxRepository(pool),messaging):undefined;
checkoutOutbox?.start();
const server = createApp(orders, verify, messaging.readiness, saga&&keys?{repository:saga,keys,refundsEnabled,...(process.env.NOTIFICATION_LOOKUP_KEY?{lookupKey:process.env.NOTIFICATION_LOOKUP_KEY}:{})}:undefined,process.env.NOTIFICATION_LOOKUP_KEY?{key:process.env.NOTIFICATION_LOOKUP_KEY,lookup:id=>orderNotificationContext(pool,id)}:undefined).listen(environment.ORDERS_PORT, environment.ORDERS_HOST, () => {
  console.info(`Orders Service listening on http://${environment.ORDERS_HOST}:${environment.ORDERS_PORT}`);
});

server.on('error', (error: Error) => {
  console.error('Orders Service server error:', error);
  process.exitCode = 1;
  void Promise.all([sagaWorker?.stop(),checkoutOutbox?.stop(),messaging.stop()]).then(() => pool.end());
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

  const messagingStopped = Promise.all([sagaWorker?.stop(),checkoutOutbox?.stop()]).then(()=>messaging.stop());
  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    if (error) {
      console.error('Orders Service shutdown failed:', error);
      process.exitCode = 1;
    }
    try { await messagingStopped; await pool.end(); }
    catch { console.error('Orders pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
