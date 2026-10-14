import {instrumentPg} from '@ecommerce/observability';
import { Pool } from 'pg';
import type { OrdersEnvironment } from '@ecommerce/config';

export function createPool(environment: OrdersEnvironment) {
  const pool = new Pool({
    host: environment.ORDERS_PGHOST, port: environment.ORDERS_PGPORT,
    database: environment.ORDERS_PGDATABASE, user: environment.ORDERS_PGUSER,
    password: environment.ORDERS_PGPASSWORD, max: environment.ORDERS_PGPOOL_MAX,
    connectionTimeoutMillis: environment.ORDERS_PGCONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 10000, statement_timeout: environment.ORDERS_PGQUERY_TIMEOUT_MS,
    query_timeout: environment.ORDERS_PGQUERY_TIMEOUT_MS,
  });
  pool.on('error', () => console.error('Orders database idle connection failed'));
  return instrumentPg(pool);
}

// Fail closed if Orders is accidentally configured with Catalog's superuser credentials.
export async function verifyDatabaseBoundary(pool: Pool): Promise<void> {
  const result = await pool.query<{ database: string; superuser: boolean; catalogAccess: boolean }>(`
    SELECT current_database() AS database, r.rolsuper AS superuser,
      EXISTS (SELECT 1 FROM pg_database d WHERE d.datname IN ('catalog_db', 'auth_db')
        AND has_database_privilege(current_user, d.oid, 'CONNECT')) AS "catalogAccess"
    FROM pg_roles r WHERE r.rolname = current_user`);
  const identity = result.rows[0];
  if (!identity || identity.database !== 'orders_db' || identity.superuser || identity.catalogAccess) {
    throw new Error('Orders requires its own non-superuser role without Auth/Catalog database access');
  }
}
