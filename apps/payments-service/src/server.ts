import '@ecommerce/observability/bootstrap';
import {RefundRepository} from './refund-repository.js';
import {RefundService} from './refund-service.js';
import {refundHandler} from './refund-consumer.js';
import {paymentsCheckoutHandler,processCheckoutPayments} from './checkout-consumer.js';
import {sagaKeys} from '@ecommerce/messaging';
import {OutboxWorker,OutboxRepository,pollWorker} from '@ecommerce/event-persistence';
import { receiptHandlers } from '@ecommerce/event-persistence';
import { bootstrapMessaging } from '@ecommerce/messaging';
import { loadPaymentsEnvironment } from '@ecommerce/config';
import { createApp } from './app.js';
import { createPool, verifyDatabaseBoundary } from './db/pool.js';
import { readFile } from 'node:fs/promises';
import { PaymentRepository } from './payment-repository.js';
import { PaymentService } from './payment-service.js';
import { ProviderClient } from './provider-client.js';
import { startReconciliationWorker } from './reconciliation-worker.js';
import { createTokenVerifier } from '@ecommerce/security';

const environment = loadPaymentsEnvironment();
const verify = await createTokenVerifier(await readFile(environment.JWT_PUBLIC_KEY_FILE, 'utf8'), {
  issuer: environment.JWT_ISSUER, audience: environment.JWT_AUDIENCE,
});
const pool = createPool(environment);
const checkoutEnabled=process.env.CHECKOUT_SAGA_ENABLED==='true';
if(checkoutEnabled && (process.env.MESSAGING_ENABLED!=='true'||process.env.MESSAGING_DIAGNOSTIC_CONSUMERS==='true'))throw new Error('Checkout requires messaging with diagnostics disabled');
const refundsEnabled=process.env.REFUNDS_ENABLED==='true';
if(refundsEnabled && (process.env.MESSAGING_ENABLED!=='true'||process.env.MESSAGING_DIAGNOSTIC_CONSUMERS==='true'))throw new Error('Refunds require messaging with diagnostics disabled');
const keys=checkoutEnabled||refundsEnabled?sagaKeys():undefined;
let payments: PaymentService;
const repository = new PaymentRepository(pool, environment.PAYMENT_LEASE_MS, environment.RECONCILIATION_INTERVAL_MS,checkoutEnabled?keys:undefined);
try {
  await verifyDatabaseBoundary(pool);
  payments = new PaymentService(repository, new ProviderClient(environment.MOCK_PROVIDER_URL, environment.PROVIDER_REQUEST_TIMEOUT_MS));
} catch {
  await pool.end();
  throw new Error('Payments startup failed; check database readiness and dedicated role permissions');
}
const worker = startReconciliationWorker(payments, environment.RECONCILIATION_INTERVAL_MS, environment.RECONCILIATION_BATCH_SIZE);
const sagaWorker=checkoutEnabled&&keys?pollWorker(()=>processCheckoutPayments(pool,payments,keys),1000):undefined;
const refunds=refundsEnabled&&keys?new RefundService(new RefundRepository(pool,keys),new ProviderClient(environment.MOCK_PROVIDER_URL,environment.PROVIDER_REQUEST_TIMEOUT_MS)):undefined;
const refundWorker=refunds?pollWorker(async()=>{await refunds.runOnce();console.info(JSON.stringify({component:'refund-metrics',states:await refunds.repository.stats()}));},1000):undefined;
const messaging = bootstrapMessaging('payments', process.env, {...receiptHandlers(pool,'payments'),...(checkoutEnabled&&keys?{'payments.checkout-commands.v1':paymentsCheckoutHandler(pool,repository,keys)}:{}),...(refunds&&keys?{'payments.refund-commands.v1':refundHandler(pool,refunds.repository,keys)}:{})});
const checkoutOutbox=keys?new OutboxWorker(new OutboxRepository(pool),messaging):undefined;
checkoutOutbox?.start();
const server = createApp(payments, verify, messaging.readiness,refunds).listen(environment.PAYMENTS_PORT, environment.PAYMENTS_HOST, () => {
  console.info(`Payments Service listening on http://${environment.PAYMENTS_HOST}:${environment.PAYMENTS_PORT}`);
});

server.on('error', (error: Error) => {
  console.error('Payments Service server error:', error);
  process.exitCode = 1;
  void Promise.all([worker.stop(),checkoutOutbox?.stop(),sagaWorker?.stop(),refundWorker?.stop(),messaging.stop()]).then(() => pool.end());
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing Payments Service`);

  const deadline = setTimeout(() => {
    console.error('Graceful shutdown deadline exceeded');
    server.closeAllConnections();
    process.exit(1);
  }, environment.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  const workerStopped = worker.stop();
  const messagingStopped = Promise.all([checkoutOutbox?.stop(),sagaWorker?.stop(),refundWorker?.stop()]).then(()=>messaging.stop());
  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    if (error) {
      console.error('Payments Service shutdown failed:', error);
      process.exitCode = 1;
    }
    try { await Promise.all([workerStopped, messagingStopped]); await pool.end(); }
    catch { console.error('Payments pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
