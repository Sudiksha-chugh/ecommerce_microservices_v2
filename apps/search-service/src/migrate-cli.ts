import { Pool } from 'pg';
import { loadSearchEnvironment } from './config.js';
import { migrate } from './migrate.js';
const env=loadSearchEnvironment();const pool=new Pool({connectionString:env.SEARCH_DATABASE_URL});try{await migrate(pool);}finally{await pool.end();}
