// Actual child-process crash fixture. Receives only isolated test settings, never development credentials.
import { Pool } from 'pg';
import { createTokenVerifier } from '@ecommerce/security';
import { createApp } from '../src/app.js';
import { PaymentRepository } from '../src/payment-repository.js';
import { PaymentService } from '../src/payment-service.js';
import { ProviderClient } from '../src/provider-client.js';
const pool = new Pool(JSON.parse(process.env.TEST_POOL!));
class CrashClient extends ProviderClient {
 override async charge(id: string,amount: number,currency: string) {
  const result = await super.charge(id,amount,currency);
  process.kill(process.pid,'SIGKILL'); // Provider committed; Payments never records result.
  return result;
 }
}
const verify = await createTokenVerifier(process.env.TEST_PUBLIC_KEY!,{issuer:'test-auth',audience:'test-api'});
const provider = process.env.CRASH_AFTER_CHARGE === 'yes' ? new CrashClient(process.env.TEST_PROVIDER!,1000) : new ProviderClient(process.env.TEST_PROVIDER!,1000);
const service = new PaymentService(new PaymentRepository(pool,100,50),provider);
const server = createApp(service,verify).listen(0,'127.0.0.1',() => { process.send?.({port:(server.address() as {port:number}).port}); });
process.on('message',() => { server.close(async () => {await pool.end();process.disconnect();}); });
