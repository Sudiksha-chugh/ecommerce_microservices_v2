import { loadOrdersEnvironment } from '@ecommerce/config';
import { createPool, verifyDatabaseBoundary } from './pool.js';
import { migrate } from './migrate.js';
const pool = createPool(loadOrdersEnvironment());
try {
  await verifyDatabaseBoundary(pool); await migrate(pool);
  console.info('Orders migrate completed');
} catch {
  console.error('Orders migration failed; check configuration, database readiness and role permissions');
  process.exitCode = 1;
} finally { await pool.end(); }
