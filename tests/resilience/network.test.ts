import {createServer,type Server,type RequestListener} from 'node:http';
import {afterEach,describe,it,expect} from 'vitest';
import {requestUpstream} from '../../apps/api-gateway/src/upstream-client.js';
import {ProviderClient} from '../../apps/payments-service/src/provider-client.js';
const servers:Server[]=[];
async function serve(handler:RequestListener){const s=createServer(handler);servers.push(s);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();if(!a||typeof a==='string')throw new Error();return `http://127.0.0.1:${a.port}`;}
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>{s.close(()=>r());s.closeAllConnections();})));});
describe('real loopback network faults without host changes',()=>{
 it('bounds slow responses and recovers',async()=>{let slow=true,calls=0;const origin=await serve((_q,r)=>{calls++;if(!slow)r.end('{}');});await expect(requestUpstream(origin,'/',25)).rejects.toMatchObject({status:504});expect(calls).toBe(1);slow=false;expect((await requestUpstream(origin,'/',1000)).status).toBe(200);});
 it('keeps deadline active over partial response bodies',async()=>{const origin=await serve((_q,r)=>{r.writeHead(200);r.write('{');});await expect(requestUpstream(origin,'/',25)).rejects.toMatchObject({status:504});});
 it('classifies connection reset as unavailable',async()=>{const origin=await serve((q)=>q.socket.destroy());await expect(requestUpstream(origin,'/',1000)).rejects.toMatchObject({status:502});});
 it('treats ambiguous payment/refund timeout as UNKNOWN',async()=>{const origin=await serve(()=>{}),provider=new ProviderClient(origin,25);expect(await provider.charge('stable-operation',100,'INR')).toEqual({status:'UNKNOWN'});expect(await provider.refundPayment('stable-refund','stable-operation',100,'INR')).toEqual({status:'UNKNOWN'});});
 it('does not send implicit retry storms',async()=>{let calls=0;const origin=await serve((_q,r)=>{calls++;r.writeHead(503);r.end('{}');});await expect(requestUpstream(origin,'/',1000)).rejects.toMatchObject({status:502});expect(calls).toBe(1);});
});
