import { Pool } from 'pg';
import type { AuthEnvironment } from '@ecommerce/config';

export function createPool(environment: AuthEnvironment) {
  const pool = new Pool({
    host: environment.AUTH_PGHOST, port: environment.AUTH_PGPORT,
    database: environment.AUTH_PGDATABASE, user: environment.AUTH_PGUSER,
    password: environment.AUTH_PGPASSWORD, max: environment.AUTH_PGPOOL_MAX,
    connectionTimeoutMillis: environment.AUTH_PGCONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 10000, statement_timeout: environment.AUTH_PGQUERY_TIMEOUT_MS,
    query_timeout: environment.AUTH_PGQUERY_TIMEOUT_MS,
  });
  pool.on('error', () => console.error('Auth database idle connection failed'));
  return pool;
}

// Fail closed if Auth is accidentally configured with Catalog's superuser credentials.
export async function verifyDatabaseBoundary(pool: Pool): Promise<void> {
  const result = await pool.query<{ database: string; superuser: boolean; catalogAccess: boolean }>(`
    SELECT current_database() AS database, r.rolsuper AS superuser,
      EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = 'catalog_db'
        AND has_database_privilege(current_user, d.oid, 'CONNECT')) AS "catalogAccess"
    FROM pg_roles r WHERE r.rolname = current_user`);
  const identity = result.rows[0];
  if (!identity || identity.database !== 'auth_db' || identity.superuser || identity.catalogAccess) {
    throw new Error('Auth requires its own non-superuser role without Catalog database access');
  }
}
