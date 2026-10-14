import {loadOrdersEnvironment} from '@ecommerce/config';
import {Messaging} from '@ecommerce/messaging';
import {OutboxRepository,OutboxWorker,outboxSettings,PUBLICATION_RETRY_DELAYS} from '@ecommerce/event-persistence';
import {z} from 'zod';
import {createPool,verifyDatabaseBoundary} from './db/pool.js';
const environment=loadOrdersEnvironment();
const options=z.object({MESSAGING_URL:z.string().min(1),OUTBOX_BATCH_SIZE:z.coerce.number().default(10),OUTBOX_POLL_INTERVAL_MS:z.coerce.number().default(1000),OUTBOX_LEASE_MS:z.coerce.number().default(30000),OUTBOX_MAX_ATTEMPTS:z.coerce.number().default(6),OUTBOX_RETRY_BASE_MS:z.coerce.number().int().min(50).max(900000).default(5000),OUTBOX_RETRY_CAP_MS:z.coerce.number().int().min(50).max(900000).default(900000),OUTBOX_SHUTDOWN_TIMEOUT_MS:z.coerce.number().default(10000)}).safeParse(process.env);
if(!options.success)throw new Error('Invalid outbox worker configuration');const env=options.data;
const settings=outboxSettings.parse({batchSize:env.OUTBOX_BATCH_SIZE,pollIntervalMs:env.OUTBOX_POLL_INTERVAL_MS,leaseMs:env.OUTBOX_LEASE_MS,maxAttempts:env.OUTBOX_MAX_ATTEMPTS,shutdownTimeoutMs:env.OUTBOX_SHUTDOWN_TIMEOUT_MS});
if(settings.leaseMs<=5000||env.OUTBOX_RETRY_CAP_MS<env.OUTBOX_RETRY_BASE_MS)throw new Error('Outbox lease must exceed confirm deadline and retry cap must exceed base');
const messaging=new Messaging({url:env.MESSAGING_URL},['orders']);const pool=createPool(environment);
try{await verifyDatabaseBoundary(pool);}catch{await pool.end();throw new Error('Orders outbox database boundary/readiness failed');}
const delay=(attempt:number) => Math.floor(Math.min(env.OUTBOX_RETRY_CAP_MS,PUBLICATION_RETRY_DELAYS[Math.min(Math.max(attempt-1,0),4)]!*env.OUTBOX_RETRY_BASE_MS/5000)*(0.8+Math.random()*0.2));
const worker=new OutboxWorker(new OutboxRepository(pool),messaging,settings,undefined,Date.now,delay);messaging.start();worker.start();
console.info(JSON.stringify({component:'outbox',outcome:'started',workerId:worker.workerId}));
// The worker's poll timer is unref'd; the AMQP socket or this lifecycle handle keeps the standalone worker alive during outages.
const lifecycle=setInterval(() => {},60000);let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,() => {if(closing)return;closing=true;const deadline=setTimeout(() => process.exit(1),settings.shutdownTimeoutMs+2000);deadline.unref();void (async () => {try{await worker.stop();await messaging.stop();await pool.end();}finally{clearInterval(lifecycle);clearTimeout(deadline);}})().catch(() => {console.error('Outbox shutdown failed');process.exitCode=1;});});
