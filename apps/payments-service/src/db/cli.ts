import { loadPaymentsEnvironment } from '@ecommerce/config';
import { createPool, verifyDatabaseBoundary } from './pool.js';
import { migrate } from './migrate.js';
const pool = createPool(loadPaymentsEnvironment());
try {
  await verifyDatabaseBoundary(pool); await migrate(pool);
  console.info('Payments migrate completed');
} catch {
  console.error('Payments migration failed; check configuration, database readiness and role permissions');
  process.exitCode = 1;
} finally { await pool.end(); }
