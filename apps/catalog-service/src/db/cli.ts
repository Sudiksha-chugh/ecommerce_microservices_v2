import { loadCatalogEnvironment } from '@ecommerce/config';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

const environment = loadCatalogEnvironment();
const pool = createPool(environment);
try {
  const command = process.argv[2];
  if (command === 'migrate') await migrate(pool);
  else if (command === 'seed') {
    if (environment.NODE_ENV === 'production') throw new Error('Development seed is disabled in production');
    await seed(pool);
  } else throw new Error('Expected migrate or seed');
  console.info(`Catalog ${command} completed`);
} catch (error) {
  console.error('Catalog database command failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
} finally {
  await pool.end();
}
