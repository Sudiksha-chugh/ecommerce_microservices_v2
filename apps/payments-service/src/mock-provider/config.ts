import { Pool } from 'pg';
import { z } from 'zod';
import { scenarioSchema } from './app.js';
export function mockEnvironment() {
 const result = z.object({ MOCK_PGHOST:z.string().min(1).default('127.0.0.1'),MOCK_PGPORT:z.coerce.number().int().min(1).max(65535).default(5432),MOCK_PGDATABASE:z.literal('mock_provider_db').default('mock_provider_db'),MOCK_PGUSER:z.string().min(1),MOCK_PGPASSWORD:z.string().min(1),MOCK_HOST:z.string().min(1).default('127.0.0.1'),MOCK_PORT:z.coerce.number().int().min(1).max(65535).default(4006),MOCK_SCENARIO:scenarioSchema.default('success'),MOCK_DELAY_MS:z.coerce.number().int().min(1).max(30000).default(3000) }).safeParse(process.env);
 if (!result.success) throw new Error('Invalid mock provider configuration'); return result.data;
}
export function mockPool(env: ReturnType<typeof mockEnvironment>) { const pool = new Pool({host:env.MOCK_PGHOST,port:env.MOCK_PGPORT,database:env.MOCK_PGDATABASE,user:env.MOCK_PGUSER,password:env.MOCK_PGPASSWORD,max:10,connectionTimeoutMillis:2000,statement_timeout:2000}); pool.on('error',() => console.error('Mock provider database connection failed')); return pool; }
export async function verifyMockBoundary(pool: Pool) {
 const row = (await pool.query(`SELECT current_database() AS db, r.rolsuper, EXISTS (SELECT 1 FROM pg_database d WHERE d.datname IN ('payments_db','orders_db','inventory_db','auth_db','catalog_db') AND has_database_privilege(current_user,d.oid,'CONNECT')) AS other_access FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
 if (row.db !== 'mock_provider_db' || row.rolsuper || row.other_access) throw new Error('Mock provider requires its dedicated database role');
}
