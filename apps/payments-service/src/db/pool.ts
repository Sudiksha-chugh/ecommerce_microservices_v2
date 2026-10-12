import { Pool } from 'pg';
import type { PaymentsEnvironment } from '@ecommerce/config';

export function createPool(environment: PaymentsEnvironment) {
  const pool = new Pool({
    host: environment.PAYMENTS_PGHOST, port: environment.PAYMENTS_PGPORT,
    database: environment.PAYMENTS_PGDATABASE, user: environment.PAYMENTS_PGUSER,
    password: environment.PAYMENTS_PGPASSWORD, max: environment.PAYMENTS_PGPOOL_MAX,
    connectionTimeoutMillis: environment.PAYMENTS_PGCONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 10000, statement_timeout: environment.PAYMENTS_PGQUERY_TIMEOUT_MS,
    query_timeout: environment.PAYMENTS_PGQUERY_TIMEOUT_MS,
  });
  pool.on('error', () => console.error('Payments database idle connection failed'));
  return pool;
}

// Fail closed if Payments is accidentally configured with Catalog's superuser credentials.
export async function verifyDatabaseBoundary(pool: Pool): Promise<void> {
  const result = await pool.query<{ database: string; superuser: boolean; catalogAccess: boolean }>(`
    SELECT current_database() AS database, r.rolsuper AS superuser,
      EXISTS (SELECT 1 FROM pg_database d WHERE d.datname IN ('catalog_db', 'auth_db', 'orders_db', 'inventory_db', 'mock_provider_db')
        AND has_database_privilege(current_user, d.oid, 'CONNECT')) AS "catalogAccess"
    FROM pg_roles r WHERE r.rolname = current_user`);
  const identity = result.rows[0];
  if (!identity || identity.database !== 'payments_db' || identity.superuser || identity.catalogAccess) {
    throw new Error('Payments requires its own non-superuser role without other service database access');
  }
}
