import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { fork, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJwtFixture } from '../../../test/jwt-fixture.js';
import { createApp } from '../src/app.js';
import { PaymentRepository } from '../src/payment-repository.js';
import { PaymentService } from '../src/payment-service.js';
import { ProviderClient } from '../src/provider-client.js';
import { createMockProvider, type Scenario } from '../src/mock-provider/app.js';
import { migrate } from '../src/db/migrate.js';
import { startReconciliationWorker } from '../src/reconciliation-worker.js';
loadEnvFile('.env.payments'); loadEnvFile('.env.mock-provider');
if (!process.env.PAYMENTS_TEST_PASSWORD || !process.env.MOCK_TEST_PASSWORD) throw new Error('Payments and provider test passwords required');
const config = {host:process.env.PAYMENTS_PGHOST ?? '127.0.0.1',port:Number(process.env.PAYMENTS_PGPORT ?? 5432),database:'payments_test_db',user:'payments_test_user',password:process.env.PAYMENTS_TEST_PASSWORD,max:10,connectionTimeoutMillis:2000,statement_timeout:3000};
const mockConfig = {...config,host:process.env.MOCK_PGHOST ?? '127.0.0.1',port:Number(process.env.MOCK_PGPORT ?? 5432),database:'mock_provider_test_db',user:'mock_provider_test_user',password:process.env.MOCK_TEST_PASSWORD};
const schema=`test_${randomUUID().replaceAll('-','')}`,mockSchema=`test_${randomUUID().replaceAll('-','')}`;
const admin=new Pool(config),mockAdmin=new Pool(mockConfig),pool=new Pool({...config,options:`-c search_path=${schema}`}),mockPool=new Pool({...mockConfig,options:`-c search_path=${mockSchema}`});
const repository=new PaymentRepository(pool,2000,50); const jwt=await createJwtFixture(); const principal=randomUUID(),owner=randomUUID();
const adminToken=`Bearer ${await jwt.sign('admin',{sub:principal})}`,customerToken=`Bearer ${await jwt.sign('customer',{sub:owner})}`;
let scenario: Scenario='success'; let server: Server; let url: string; let chargeCalls=0,lookupCalls=0; let app: ReturnType<typeof createApp>; let service: PaymentService;
const workers: ReturnType<typeof startReconciliationWorker>[]=[]; const children: ChildProcess[]=[]; let createdSchema=false,createdMockSchema=false;
const input=() => ({orderId:randomUUID(),userId:owner,amountPaise:50000,currency:'INR' as const});
const application=(origin=url,timeout=1000) => { service=new PaymentService(repository,new ProviderClient(origin,timeout)); return createApp(service,jwt.verify); };
const create=(body: object=input(),key: string=randomUUID(),token=adminToken) => request(app).post('/payments/intents').set('authorization',token).set('idempotency-key',key).send(body);
const operate=(id: string,action='process') => request(app).post(`/payments/${id}/${action}`).set('authorization',adminToken).send({});
const payment=async () => (await create().expect(201)).body.paymentId as string;
const state=async (id: string) => (await request(app).get(`/payments/${id}`).set('authorization',adminToken).expect(200)).body;
const chargeCount=async () => (await mockPool.query("SELECT * FROM mock_charges WHERE status='SUCCEEDED'")).rowCount;
async function child(crash: boolean) {
 const process=fork(new URL('./crash-server.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...globalThis.process.env,TEST_POOL:JSON.stringify({...config,options:`-c search_path=${schema}`}),TEST_PUBLIC_KEY:jwt.publicPem,TEST_PROVIDER:url,CRASH_AFTER_CHARGE:crash?'yes':'no'},stdio:['ignore','ignore','ignore','ipc']}); children.push(process);
 const port=await new Promise<number>((resolve,reject) => { const timer=setTimeout(() => reject(new Error('Child startup timeout')),5000);process.once('error',reject);process.once('message',(msg) => {clearTimeout(timer);resolve((msg as {port:number}).port);});process.once('exit',(code) => {clearTimeout(timer);reject(new Error(`Child exited ${code}`));}); });
 return {process,url:`http://127.0.0.1:${port}`};
}
beforeAll(async () => {
 expect((await admin.query('SELECT current_database() AS db,current_user AS role')).rows[0]).toEqual({db:'payments_test_db',role:'payments_test_user'});
 expect((await mockAdmin.query('SELECT current_database() AS db,current_user AS role')).rows[0]).toEqual({db:'mock_provider_test_db',role:'mock_provider_test_user'});
 await admin.query(`CREATE SCHEMA "${schema}"`);createdSchema=true;await migrate(pool);
 await mockAdmin.query(`CREATE SCHEMA "${mockSchema}"`);createdMockSchema=true;await mockPool.query(await readFile(new URL('../src/mock-provider/schema.sql',import.meta.url),'utf8'));
 const provider=createMockProvider(mockPool,() => scenario,200); server=createServer((req,res) => {if(req.method==='POST')chargeCalls++;else lookupCalls++;provider(req,res);});
 await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;app=application();
});
beforeEach(async () => {await pool.query('TRUNCATE payments CASCADE');await mockPool.query('TRUNCATE mock_charges');scenario='success';chargeCalls=0;lookupCalls=0;app=application();});
afterEach(async () => {
 await Promise.all(workers.splice(0).map((worker) => worker.stop()));
 for (const process of children.splice(0)) if (process.exitCode===null && process.signalCode===null) {const exited=new Promise<void>((resolve) => process.once('exit',() => resolve()));process.send('shutdown');await exited;}
 vi.restoreAllMocks();
});
afterAll(async () => {if(server)await new Promise<void>((resolve) => {server.close(() => resolve());server.closeAllConnections();});await Promise.all([pool.end(),mockPool.end()]);if(createdSchema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);if(createdMockSchema)await mockAdmin.query(`DROP SCHEMA "${mockSchema}" CASCADE`);await Promise.all([admin.end(),mockAdmin.end()]);});
describe('Payment intents and principal-scoped idempotency',() => {
 it('provides health and creates a payment intent',async () => {await request(app).get('/health').expect(200);const body=input();const r=await create(body).expect(201);expect(r.body).toEqual({paymentId:expect.any(String),orderId:body.orderId,status:'CREATED',amountPaise:50000,currency:'INR'});expect(r.headers.location).toBe(`/payments/${r.body.paymentId}`);expect((await pool.query('SELECT * FROM payment_attempts')).rowCount).toBe(0);});
 it('returns the original payment on an identical retry',async () => {const body=input(),key=randomUUID();const first=await create(body,key).expect(201);expect((await create(body,key).expect(201)).body).toEqual(first.body);});
 it('canonicalizes UUIDs and rejects changed payloads',async () => {const body=input(),key=randomUUID();const first=await create(body,key).expect(201);expect((await create({...body,orderId:body.orderId.toUpperCase(),userId:body.userId.toUpperCase()},key).expect(201)).body).toEqual(first.body);for(const changed of [{amountPaise:1},{orderId:randomUUID()},{userId:randomUUID()}])await create({...body,...changed},key).expect(409);});
 it('scopes replay to the authorized principal, even across different owners',async () => {const key=randomUUID(),body=input();await create(body,key).expect(201);await create({...input(),userId:randomUUID()},key).expect(409);const other=`Bearer ${await jwt.sign('admin',{sub:randomUUID()})}`;await create({...input(),userId:randomUUID()},key,other).expect(201);});
 it('enforces one payment per order',async () => {const body=input();await create(body).expect(201);await create(body).expect(409);});
 it('serializes concurrent identical creation',async () => {const body=input(),key=randomUUID();const r=await Promise.all(Array.from({length:10},() => create(body,key).expect(201)));expect(new Set(r.map((r) => r.body.paymentId)).size).toBe(1);expect((await pool.query('SELECT * FROM payments')).rowCount).toBe(1);});
 it('serializes conflicting concurrent creation',async () => {const body=input(),key=randomUUID();expect((await Promise.all([create(body,key),create({...body,amountPaise:1},key)])).map((r) => r.status).sort()).toEqual([201,409]);});
 it.each([{}, {orderId:'bad',userId:owner,amountPaise:1,currency:'INR'}, {...input(),userId:'bad'}, ...[0,-1,1.5,'50',Number.MAX_SAFE_INTEGER+1].map((amountPaise) => ({...input(),amountPaise})), {...input(),currency:'USD'}, {...input(),extra:1}])('rejects invalid intent %j',async (body) => {await create(body).expect(400);});
 it.each(['','contains space','x'.repeat(256)])('rejects invalid key',async (key) => {await create(input(),key).expect(400);});
 it('requires a key and rejects malformed JSON',async () => {await request(app).post('/payments/intents').set('authorization',adminToken).send(input()).expect(400);await request(app).post('/payments/intents').set('authorization',adminToken).set('idempotency-key','test').set('content-type','application/json').send('{').expect(400);});
 it('preserves safe BIGINT money',async () => {const id=(await create({...input(),amountPaise:Number.MAX_SAFE_INTEGER}).expect(201)).body.paymentId;expect((await operate(id).expect(200)).body.amountPaise).toBe(Number.MAX_SAFE_INTEGER);});
});
describe('Processing and persisted state machine',() => {
 it('charges once, persists attempt, and returns stable successful retries',async () => {const id=await payment();const first=await operate(id).expect(200);expect(first.body.status).toBe('SUCCEEDED');expect((await operate(id).expect(200)).body).toEqual(first.body);expect((await operate(id,'reconcile').expect(200)).body).toEqual(first.body);expect(await chargeCount()).toBe(1);expect(chargeCalls).toBe(1);expect((await pool.query('SELECT * FROM payment_attempts')).rows[0]).toMatchObject({status:'SUCCEEDED',attempt_number:1,provider_request_id:id});});
 it('serializes concurrent processing requests',async () => {const id=await payment();const r=await Promise.all(Array.from({length:12},() => operate(id)));expect(r.every((r) => [200,202].includes(r.status))).toBe(true);expect((await state(id)).status).toBe('SUCCEEDED');expect(chargeCalls).toBe(1);expect(await chargeCount()).toBe(1);});
 it.each(['decline','temporary-failure'] as const)('persists definitive %s without another charge',async (mode) => {scenario=mode;const id=await payment();expect((await operate(id).expect(200)).body.status).toBe('FAILED');scenario='success';expect((await operate(id).expect(200)).body.status).toBe('FAILED');expect((await operate(id,'reconcile').expect(200)).body.status).toBe('FAILED');expect(chargeCalls).toBe(1);expect(await chargeCount()).toBe(0);});
 it.each(['timeout','lost-response'] as const)('reconciles a charge after %s without resubmission',async (mode) => {scenario=mode;app=application(url,50);const id=await payment();expect((await operate(id).expect(200)).body.status).toBe('REQUIRES_RECONCILIATION');expect(await chargeCount()).toBe(1);await operate(id).expect(200);expect(chargeCalls).toBe(1);const done=await operate(id,'reconcile').expect(200);expect(done.body.status).toBe('SUCCEEDED');expect((await operate(id,'reconcile').expect(200)).body).toEqual(done.body);expect(chargeCalls).toBe(1);expect(lookupCalls).toBe(1);});
 it('keeps unknown outcomes uncertain until the original provider operation resolves',async () => {scenario='ambiguous';const id=await payment();expect((await operate(id).expect(200)).body.status).toBe('REQUIRES_RECONCILIATION');expect((await operate(id,'reconcile').expect(200)).body.status).toBe('REQUIRES_RECONCILIATION');await mockPool.query("UPDATE mock_charges SET status='FAILED',failure_code='DECLINED' WHERE request_id=$1",[id]);expect((await operate(id,'reconcile').expect(200)).body.status).toBe('FAILED');expect(chargeCalls).toBe(1);});
 it('keeps provider unavailability ambiguous and never generates a replacement charge',async () => {const offline=createServer();await new Promise<void>((resolve) => offline.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(offline.address() as AddressInfo).port}`;await new Promise<void>((resolve) => offline.close(() => resolve()));app=application(origin);const id=await payment();expect((await operate(id).expect(200)).body.status).toBe('REQUIRES_RECONCILIATION');app=application();expect((await operate(id,'reconcile').expect(200)).body.status).toBe('REQUIRES_RECONCILIATION');expect(await chargeCount()).toBe(0);expect(chargeCalls).toBe(0);});
 it('reconciles concurrent callers without double mutation',async () => {scenario='lost-response';const id=await payment();await operate(id).expect(200);await Promise.all(Array.from({length:10},() => operate(id,'reconcile').expect(200)));expect((await state(id)).status).toBe('SUCCEEDED');expect(await chargeCount()).toBe(1);expect(lookupCalls).toBe(1);});
 it('fences a stale processing result after lease recovery',async () => {const id=await payment();const original=await repository.claim(id,'process');await pool.query("UPDATE payments SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[id]);const recovery=await repository.claim(id,'reconcile');const done=await repository.finish(id,recovery.token!,{status:'FAILED',failureCode:'DECLINED'});expect(done.status).toBe('FAILED');expect((await repository.finish(id,original.token!,{status:'SUCCEEDED',providerPaymentId:randomUUID()})).status).toBe('FAILED');});
 it.each(['process','reconcile'])('validates %s paths and operation bodies',async (action) => {await operate('bad',action).expect(400);await operate(randomUUID(),action).expect(404);await request(app).post(`/payments/${randomUUID()}/${action}`).set('authorization',adminToken).send({extra:1}).expect(400);});
 it('rejects reconciliation before processing without creating an attempt',async () => {const id=await payment();await operate(id,'reconcile').expect(409);expect((await state(id)).status).toBe('CREATED');expect((await pool.query('SELECT * FROM payment_attempts')).rowCount).toBe(0);expect(chargeCalls).toBe(0);});
 it('does not hold a local transaction open during provider I/O',async () => {scenario='timeout';const id=await payment();const running=operate(id).then((r) => r);await vi.waitFor(async () => expect(await chargeCount()).toBe(1));const client=await pool.connect();try {await client.query('BEGIN');await client.query('SET LOCAL lock_timeout=100');await client.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE NOWAIT',[id]);await client.query('ROLLBACK');} finally {client.release();}expect((await running).status).toBe(200);});
});
describe('Reconciliation worker and real process crash recovery',() => {
 it('recovers a killed Payments process after provider commit, then survives a second restart',async () => {
  const id=await payment();const crashing=await child(true);const death=new Promise<void>((resolve) => crashing.process.once('exit',() => resolve()));
  await expect(fetch(`${crashing.url}/payments/${id}/process`,{method:'POST',headers:{authorization:adminToken}})).rejects.toThrow();await death;
  expect((await state(id)).status).toBe('PROCESSING');expect(await chargeCount()).toBe(1);expect((await pool.query('SELECT * FROM payment_attempts WHERE payment_id=$1',[id])).rows[0]).toMatchObject({status:'PROCESSING',provider_request_id:id});
  await new Promise((resolve) => setTimeout(resolve,120));const restarted=await child(false);const recovered=await fetch(`${restarted.url}/payments/${id}/reconcile`,{method:'POST',headers:{authorization:adminToken}});expect(recovered.status).toBe(200);expect((await recovered.json() as {status:string}).status).toBe('SUCCEEDED');expect(chargeCalls).toBe(1);
  const exited=new Promise<void>((resolve) => restarted.process.once('exit',() => resolve()));restarted.process.send('shutdown');await exited;
  const again=await child(false);const retry=await fetch(`${again.url}/payments/${id}/process`,{method:'POST',headers:{authorization:adminToken}});expect((await retry.json() as {status:string}).status).toBe('SUCCEEDED');expect(chargeCalls).toBe(1);expect(await chargeCount()).toBe(1);
 },15000);
 it('recovers an expired processing claim through concurrent worker instances',async () => {
  const id=await payment(),claim=await repository.claim(id,'process');await new ProviderClient(url,1000).charge(claim.requestId!,50000,'INR');await pool.query("UPDATE payments SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[id]);
  await Promise.all(Array.from({length:5},() => service.reconcileBatch(10)));expect((await state(id)).status).toBe('SUCCEEDED');expect(lookupCalls).toBe(1);expect(await chargeCount()).toBe(1);
 });
 it('logs worker storage failures generically and continues after recovery',async () => {
  const log=vi.spyOn(console,'error').mockImplementation(() => {});await pool.query('ALTER TABLE payments RENAME TO payments_unavailable');
  const worker=startReconciliationWorker(service,50,1);workers.push(worker);
  try {await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Payment reconciliation failed'));}finally{await worker.stop();await pool.query('ALTER TABLE payments_unavailable RENAME TO payments');}
  expect(log.mock.calls.flat().every((message) => !String(message).includes('SELECT'))).toBe(true);
 });
 it('runs a bounded worker and stops scheduling on shutdown',async () => {scenario='lost-response';const id=await payment();await operate(id).expect(200);const log=vi.spyOn(console,'info').mockImplementation(() => {});const worker=startReconciliationWorker(service,50,2);workers.push(worker);await vi.waitFor(async () => expect((await state(id)).status).toBe('SUCCEEDED'));await worker.stop();expect(log).toHaveBeenCalled();});
});
describe('Independent JWT and owner-level status access',() => {
 it.each([['post','/payments/intents'],['post',`/payments/${owner}/process`],['post',`/payments/${owner}/reconcile`],['get',`/payments/${owner}`]] as const)('requires authentication on %s %s',async (method,path) => {await request(app)[method](path).set('X-Service-Name','orders').send({}).expect(401);});
 it.each(['/payments/intents',`/payments/${owner}/process`,`/payments/${owner}/reconcile`])('forbids customers writing %s',async (path) => {await request(app).post(path).set('authorization',customerToken).set('X-Service-Name','orders').send({}).expect(403);});
 it('allows owners to read only public payment information and hides other owners',async () => {const id=await payment();const response=await request(app).get(`/payments/${id}`).set('authorization',customerToken).expect(200);expect(Object.keys(response.body).sort()).toEqual(['paymentId','orderId','status','amountPaise','currency'].sort());await request(app).get(`/payments/${id}`).set('authorization',`Bearer ${await jwt.sign('customer',{sub:randomUUID()})}`).expect(404);await request(app).get(`/payments/${randomUUID()}`).set('authorization',customerToken).expect(404);});
 it.each([{exp:1},{iss:'wrong'},{aud:'wrong'},{sub:'bad'},{role:'service'}])('rejects invalid JWT claims %j',async (claims) => {await request(app).get(`/payments/${owner}`).set('authorization',`Bearer ${await jwt.sign('admin',claims)}`).expect(401);});
 it('rejects forged signatures',async () => {const other=await createJwtFixture();await request(app).get(`/payments/${owner}`).set('authorization',`Bearer ${await other.sign()}`).expect(401);});
});
describe('Database constraints and local transaction failures',() => {
 it('enforces money, status, uniqueness, attempts, and provider IDs',async () => {
  const id=await payment();for(const [query,params,code] of [["UPDATE payments SET amount_paise=0 WHERE id=$1",[id],'23514'],["UPDATE payments SET status='BAD' WHERE id=$1",[id],'23514'],["INSERT INTO payment_attempts(payment_id,attempt_number,status,provider_request_id) VALUES ($1,0,'PROCESSING','bad')",[id],'23514'],["INSERT INTO payment_attempts(payment_id,attempt_number,status,provider_request_id) VALUES ($1,1,'PROCESSING','orphan')",[randomUUID()],'23503']] as const)await expect(pool.query(query,[...params])).rejects.toMatchObject({code});
  await operate(id).expect(200);await expect(pool.query("INSERT INTO payment_attempts(payment_id,attempt_number,status,provider_request_id) VALUES ($1,1,'PROCESSING','duplicate')",[id])).rejects.toMatchObject({code:'23505'});
  const second=await payment();await expect(pool.query('UPDATE payments SET provider_payment_id=(SELECT provider_payment_id FROM payments WHERE id=$1) WHERE id=$2',[id,second])).rejects.toMatchObject({code:'23505'});
 });
 it('rolls back a failed attempt claim before any provider call',async () => {
  const id=await payment();await pool.query("CREATE FUNCTION fail_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private SQL'; END $$");await pool.query('CREATE TRIGGER fail_attempt BEFORE INSERT ON payment_attempts FOR EACH ROW EXECUTE FUNCTION fail_attempt()');
  try {const r=await operate(id).expect(500);expect(r.text).not.toContain('private SQL');expect((await state(id)).status).toBe('CREATED');expect(chargeCalls).toBe(0);expect((await pool.query('SELECT * FROM payment_attempts')).rowCount).toBe(0);}finally{await pool.query('DROP TRIGGER fail_attempt ON payment_attempts');await pool.query('DROP FUNCTION fail_attempt()');}
 });
 it('recovers a provider success after result persistence rolls back',async () => {
  const id=await payment();await pool.query("CREATE FUNCTION fail_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='SUCCEEDED' THEN RAISE EXCEPTION 'private SQL'; END IF; RETURN NEW; END $$");await pool.query('CREATE TRIGGER fail_result BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION fail_result()');
  try {await operate(id).expect(500);expect((await state(id)).status).toBe('PROCESSING');expect(await chargeCount()).toBe(1);expect((await pool.query('SELECT * FROM payment_attempts')).rows[0].status).toBe('PROCESSING');}finally{await pool.query('DROP TRIGGER fail_result ON payments');await pool.query('DROP FUNCTION fail_result()');}
  await pool.query("UPDATE payments SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[id]);expect((await operate(id,'reconcile').expect(200)).body.status).toBe('SUCCEEDED');expect(chargeCalls).toBe(1);
 });
 it('reuses the provider key independently of Payments transactions',async () => {const id=randomUUID();const client=new ProviderClient(url,1000);const r=await Promise.all(Array.from({length:10},() => client.charge(id,10,'INR')));expect(new Set(r.map((result) => JSON.stringify(result))).size).toBe(1);expect(await chargeCount()).toBe(1);const mismatch=await client.charge(id,20,'INR');expect(mismatch.status).toBe('UNKNOWN');expect(await chargeCount()).toBe(1);});
 it('runs migrations repeatedly without reapplying',async () => {await migrate(pool);expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(1);});
 it.each(['payments_db','mock_provider_db','orders_db','inventory_db','catalog_db','auth_db','mock_provider_test_db'])('Payments test role cannot access %s',async (database) => {const other=new Pool({...config,database});try {await expect(other.query('SELECT 1')).rejects.toMatchObject({code:'42501'});}finally{await other.end();}});
 it.each(['payments_test_db','payments_db','mock_provider_db','orders_db','inventory_db'])('provider test role cannot access %s',async (database) => {const other=new Pool({...mockConfig,database});try {await expect(other.query('SELECT 1')).rejects.toMatchObject({code:'42501'});}finally{await other.end();}});
});
