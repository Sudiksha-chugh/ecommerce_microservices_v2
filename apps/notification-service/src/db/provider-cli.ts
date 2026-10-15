import {readFile} from 'node:fs/promises';
import {loadNotificationEnvironment} from '../config.js';
import {notificationPool} from './pool.js';
const env=loadNotificationEnvironment(),pool=notificationPool(env.MOCK_EMAIL_DATABASE_URL);
try{const r=(await pool.query('SELECT current_database() AS db,r.rolsuper FROM pg_roles r WHERE r.rolname=current_user')).rows[0];if(r.db!=='mock_email_provider_db'||r.rolsuper)throw new Error('Wrong provider database');await pool.query(await readFile(new URL('../providers/mock-schema.sql',import.meta.url),'utf8'));console.info('Mock email schema ready');}catch{console.error('Mock email migration failed');process.exitCode=1;}finally{await pool.end();}
