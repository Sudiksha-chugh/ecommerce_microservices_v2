import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import type {EmailProvider,EmailRequest,DeliveryResult} from './email-provider.js';
export type EmailScenario='success'|'temporary'|'permanent'|'timeout'|'lost-response'|'unavailable'|'unknown';
export class DeterministicMockEmailProvider implements EmailProvider {
 readonly channel='EMAIL' as const;readonly capabilities={idempotentSend:true,statusLookup:true};
 constructor(private readonly pool:Pool,private readonly scenario:()=>EmailScenario=()=> 'success'){}
 private view(row:{status:string;provider_message_id:string|null}):DeliveryResult{return row.status==='ACCEPTED'?{status:'ACCEPTED',messageId:row.provider_message_id!}:row.status==='PERMANENT'?{status:'NOT_ACCEPTED',classification:'PERMANENT',code:'PROVIDER_REJECTED'}:row.status==='TRANSIENT'?{status:'NOT_ACCEPTED',classification:'TRANSIENT',code:'PROVIDER_TEMPORARY_FAILURE'}:{status:'UNKNOWN'};}
 async sendEmail(request:EmailRequest):Promise<DeliveryResult>{
  const valid=z.strictObject({operationId:z.uuid(),recipient:z.email().max(320),content:z.strictObject({subject:z.string().max(200),text:z.string().max(10000),html:z.string().max(20000),version:z.number().int().positive()})}).parse(request);
  const fingerprint=createHash('sha256').update(JSON.stringify(valid)).digest('hex'),mode=this.scenario();
  if(mode==='unavailable')return {status:'NOT_ACCEPTED',classification:'TRANSIENT',code:'PROVIDER_UNAVAILABLE'};
  const client=await this.pool.connect();let row;
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,14014))',[request.operationId]);
   row=(await client.query('SELECT * FROM mock_email_deliveries WHERE operation_id=$1 FOR UPDATE',[request.operationId])).rows[0];
   if(row&&row.request_fingerprint!==fingerprint){await client.query('ROLLBACK');return {status:'NOT_ACCEPTED',classification:'PERMANENT',code:'PROVIDER_REQUEST_CONFLICT'};}
   if(!row||row.status==='TRANSIENT'){
    const status=mode==='temporary'?'TRANSIENT':mode==='permanent'?'PERMANENT':mode==='unknown'?'UNKNOWN':'ACCEPTED';
    row=(await client.query(`INSERT INTO mock_email_deliveries(operation_id,request_fingerprint,status,provider_message_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(operation_id) DO UPDATE SET status=EXCLUDED.status,provider_message_id=EXCLUDED.provider_message_id,send_calls=mock_email_deliveries.send_calls+1,updated_at=clock_timestamp() RETURNING *`,[request.operationId,fingerprint,status,status==='ACCEPTED'?randomUUID():null])).rows[0];
   }else await client.query('UPDATE mock_email_deliveries SET send_calls=send_calls+1 WHERE operation_id=$1',[request.operationId]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  // Timeout/lost-response are represented after durable independent provider acceptance.
  if(mode==='timeout'||mode==='lost-response')return {status:'UNKNOWN'};
  return this.view(row);
 }
 async getDeliveryStatus(operationId:string):Promise<DeliveryResult>{
  z.uuid().parse(operationId);if(this.scenario()==='unavailable')return {status:'UNKNOWN'};
  const row=(await this.pool.query('UPDATE mock_email_deliveries SET lookup_calls=lookup_calls+1 WHERE operation_id=$1 RETURNING *',[operationId])).rows[0];
  return row?this.view(row):{status:'NOT_ACCEPTED',classification:'TRANSIENT',code:'PROVIDER_NOT_ACCEPTED'};
 }
}
