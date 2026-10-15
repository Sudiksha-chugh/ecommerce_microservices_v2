import {loadNotificationEnvironment} from '../config.js';
import {notificationPool,verifyNotificationBoundary} from './pool.js';
import {migrate} from './migrate.js';
const env=loadNotificationEnvironment(),pool=notificationPool(env.DATABASE_URL);
try{await verifyNotificationBoundary(pool);await migrate(pool);console.info('Notification migrations completed');}catch{console.error('Notification migration failed');process.exitCode=1;}finally{await pool.end();}
