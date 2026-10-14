import {instrumentPg} from '@ecommerce/observability';
import { Pool } from 'pg';
import type { InventoryEnvironment } from '@ecommerce/config';

export function createPool(environment: InventoryEnvironment) {
  const pool = new Pool({
    host: environment.INVENTORY_PGHOST, port: environment.INVENTORY_PGPORT,
    database: environment.INVENTORY_PGDATABASE, user: environment.INVENTORY_PGUSER,
    password: environment.INVENTORY_PGPASSWORD, max: environment.INVENTORY_PGPOOL_MAX,
    connectionTimeoutMillis: environment.INVENTORY_PGCONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 10000, statement_timeout: environment.INVENTORY_PGQUERY_TIMEOUT_MS,
    query_timeout: environment.INVENTORY_PGQUERY_TIMEOUT_MS,
  });
  pool.on('error', () => console.error('Inventory database idle connection failed'));
  return instrumentPg(pool);
}

// Fail closed if Inventory is accidentally configured with Catalog's superuser credentials.
export async function verifyDatabaseBoundary(pool: Pool): Promise<void> {
  const result = await pool.query<{ database: string; superuser: boolean; catalogAccess: boolean }>(`
    SELECT current_database() AS database, r.rolsuper AS superuser,
      EXISTS (SELECT 1 FROM pg_database d WHERE d.datname IN ('catalog_db', 'auth_db', 'orders_db')
        AND has_database_privilege(current_user, d.oid, 'CONNECT')) AS "catalogAccess"
    FROM pg_roles r WHERE r.rolname = current_user`);
  const identity = result.rows[0];
  if (!identity || identity.database !== 'inventory_db' || identity.superuser || identity.catalogAccess) {
    throw new Error('Inventory requires its own non-superuser role without other service database access');
  }
}
