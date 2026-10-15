import type {SagaKeys} from '@ecommerce/messaging';
import {z} from 'zod';
const origin=z.url().refine(v=>{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash;});
const db=z.url().refine(v=>['postgres:','postgresql:'].includes(new URL(v).protocol));
const flag=z.enum(['true','false']).default('false').transform(v=>v==='true');
const schema=z.object({
 NOTIFICATION_HOST:z.string().min(1).default('127.0.0.1'),NOTIFICATION_PORT:z.coerce.number().int().min(1).max(65535).default(4007),
 DATABASE_URL:db,MOCK_EMAIL_DATABASE_URL:db,RABBITMQ_URL:z.string().optional(),
 NOTIFICATION_PROVIDER:z.literal('mock').default('mock'),NOTIFICATION_WORKER_ENABLED:flag,NOTIFICATION_CONSUMER_ENABLED:flag,
 NOTIFICATION_MAX_ATTEMPTS:z.coerce.number().int().min(1).max(30).default(5),NOTIFICATION_RETRY_BASE_MS:z.coerce.number().int().min(10).max(1800000).default(30000),
 NOTIFICATION_LEASE_MS:z.coerce.number().int().min(100).max(300000).default(30000),NOTIFICATION_POLL_MS:z.coerce.number().int().min(50).max(60000).default(1000),
 NOTIFICATION_BATCH_SIZE:z.coerce.number().int().min(1).max(50).default(10),NOTIFICATION_RETENTION_DAYS:z.coerce.number().int().min(1).max(3650).default(30),
 NOTIFICATION_LOOKUP_KEY:z.string().min(32),AUTH_SERVICE_URL:origin.default('http://127.0.0.1:4000'),ORDERS_SERVICE_URL:origin.default('http://127.0.0.1:4003'),
 NOTIFICATION_LOOKUP_TIMEOUT_MS:z.coerce.number().int().min(50).max(10000).default(3000),
 JWT_PUBLIC_KEY_FILE:z.string().min(1),JWT_ISSUER:z.string().min(1),JWT_AUDIENCE:z.string().min(1),
 SHUTDOWN_TIMEOUT_MS:z.coerce.number().int().min(100).max(120000).default(10000),MOCK_EMAIL_SCENARIO:z.enum(['success','temporary','permanent','timeout','lost-response','unavailable','unknown']).default('success')
});
export function loadNotificationEnvironment(env:NodeJS.ProcessEnv=process.env){const result=schema.safeParse(env);if(!result.success)throw new Error('Invalid Notification configuration');const e=result.data;if(e.DATABASE_URL===e.MOCK_EMAIL_DATABASE_URL)throw new Error('Mock email provider requires an independent database');if(e.NOTIFICATION_CONSUMER_ENABLED&&!e.RABBITMQ_URL)throw new Error('Notification consumer requires broker credentials');return e;}

export function notificationVerificationKeys(env:NodeJS.ProcessEnv=process.env):SagaKeys {
 const orders=env.SAGA_ORDERS_KEY??'',payments=env.SAGA_PAYMENTS_KEY??'';
 if(orders.length<32||payments.length<32||orders===payments)throw new Error('Notification verification requires distinct Orders and Payments keys');
 return {'orders-service':orders,'payments-service':payments,'inventory-service':'unused-notification-inventory-verifier-key'};
}
