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
let payments: PaymentService;
const repository = new PaymentRepository(pool, environment.PAYMENT_LEASE_MS, environment.RECONCILIATION_INTERVAL_MS);
try {
  await verifyDatabaseBoundary(pool);
  payments = new PaymentService(repository, new ProviderClient(environment.MOCK_PROVIDER_URL, environment.PROVIDER_REQUEST_TIMEOUT_MS));
} catch {
  await pool.end();
  throw new Error('Payments startup failed; check database readiness and dedicated role permissions');
}
const worker = startReconciliationWorker(payments, environment.RECONCILIATION_INTERVAL_MS, environment.RECONCILIATION_BATCH_SIZE);
const server = createApp(payments, verify).listen(environment.PAYMENTS_PORT, environment.PAYMENTS_HOST, () => {
  console.info(`Payments Service listening on http://${environment.PAYMENTS_HOST}:${environment.PAYMENTS_PORT}`);
});

server.on('error', (error: Error) => {
  console.error('Payments Service server error:', error);
  process.exitCode = 1;
  void worker.stop().then(() => pool.end());
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
  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    if (error) {
      console.error('Payments Service shutdown failed:', error);
      process.exitCode = 1;
    }
    try { await workerStopped; await pool.end(); }
    catch { console.error('Payments pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
