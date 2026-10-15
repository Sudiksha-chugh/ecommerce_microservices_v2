import { readFile } from 'node:fs/promises';
import { mockEnvironment,mockPool,verifyMockBoundary } from './config.js';
const pool=mockPool(mockEnvironment());
try { await verifyMockBoundary(pool); await pool.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8')); await pool.query(await readFile(new URL('./migrations/002-refunds.sql',import.meta.url),'utf8')); console.info('Mock provider schema ready'); }
catch { console.error('Mock provider migration failed'); process.exitCode=1; }
finally { await pool.end(); }
