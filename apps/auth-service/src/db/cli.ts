import { loadAuthEnvironment } from '@ecommerce/config';
import { registrationSchema } from '../user-validation.js';
import { createPool, verifyDatabaseBoundary } from './pool.js';
import { migrate } from './migrate.js';
import { UserRepository } from '../user-repository.js';
import { bootstrapAdmin } from '../bootstrap-admin.js';

const environment = loadAuthEnvironment();
const pool = createPool(environment);
try {
  await verifyDatabaseBoundary(pool);
  const command = process.argv[2];
  if (command === 'migrate') await migrate(pool);
  else if (command === 'bootstrap-admin') {
    if (environment.NODE_ENV === 'production') throw new Error('Local admin bootstrap disabled in production');
    const parsed = registrationSchema.safeParse({
      email: process.env.AUTH_BOOTSTRAP_EMAIL, password: process.env.AUTH_BOOTSTRAP_PASSWORD,
    });
    if (!parsed.success) throw new Error('Set valid AUTH_BOOTSTRAP_EMAIL and AUTH_BOOTSTRAP_PASSWORD');
    const created = await bootstrapAdmin(new UserRepository(pool), parsed.data, environment.NODE_ENV);
    if (!created) console.info('Admin already exists; password and role were not changed');
  } else throw new Error('Expected migrate or bootstrap-admin');
  console.info(`Auth ${command} completed`);
} catch {
  console.error('Auth database command failed; check configuration, database readiness, and bootstrap inputs');
  process.exitCode = 1;
} finally { await pool.end(); }
