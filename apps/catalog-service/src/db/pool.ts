import { Pool } from 'pg';
import type { CatalogEnvironment } from '@ecommerce/config';

export function createPool(environment: CatalogEnvironment) {
  const pool = new Pool({
    host: environment.PGHOST, port: environment.PGPORT,
    database: environment.PGDATABASE, user: environment.PGUSER,
    password: environment.PGPASSWORD, max: environment.PGPOOL_MAX,
    connectionTimeoutMillis: environment.PGCONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 10000,
    statement_timeout: environment.PGQUERY_TIMEOUT_MS,
    query_timeout: environment.PGQUERY_TIMEOUT_MS,
  });
  pool.on('error', () => console.error('Catalog database idle connection failed'));
  return pool;
}
