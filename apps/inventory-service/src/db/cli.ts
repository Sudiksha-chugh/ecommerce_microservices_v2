import { loadInventoryEnvironment } from '@ecommerce/config';
import { createPool, verifyDatabaseBoundary } from './pool.js';
import { migrate } from './migrate.js';
const pool = createPool(loadInventoryEnvironment());
try {
  await verifyDatabaseBoundary(pool); await migrate(pool);
  console.info('Inventory migrate completed');
} catch {
  console.error('Inventory migration failed; check configuration, database readiness and role permissions');
  process.exitCode = 1;
} finally { await pool.end(); }
