import type express from 'express';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import type {Scenario} from './app.js';
export function installRefundRoutes(app:express.Express,pool:Pool,scenario:()=>Scenario,delayMs:number){
 const body=z.strictObject({operationId:z.uuid(),paymentRequestId:z.uuid(),amountPaise:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency:z.literal('INR')});
 const view=(r:{status:string;provider_refund_id:string|null;failure_code:string|null})=>r.status==='SUCCEEDED'?{status:'SUCCEEDED',providerRefundId:r.provider_refund_id}:r.status==='FAILED'?{status:'FAILED',failureCode:r.failure_code}:{status:'UNKNOWN'};
 app.post('/refunds',async(req,res)=>{
  const parsed=body.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid refund'});return;}const p=parsed.data,mode=scenario();
  const client=await pool.connect();let row;
  try{
   await client.query('BEGIN');
   const payment=(await client.query('SELECT * FROM mock_charges WHERE request_id=$1 FOR UPDATE',[p.paymentRequestId])).rows[0];
   row=(await client.query('SELECT * FROM mock_refunds WHERE operation_id=$1',[p.operationId])).rows[0];
   if(row){if(row.payment_request_id!==p.paymentRequestId||BigInt(row.amount_paise)!==BigInt(p.amountPaise)||row.currency!==p.currency){await client.query('ROLLBACK');res.status(409).json({error:'Refund operation conflicts'});return;}}
   else {
    if(!payment||payment.status!=='SUCCEEDED'||payment.currency!==p.currency){await client.query('ROLLBACK');res.json({status:'FAILED',failureCode:'NOT_REFUNDABLE'});return;}
    const used=(await client.query("SELECT COALESCE(SUM(amount_paise),0)::text AS amount FROM mock_refunds WHERE payment_request_id=$1 AND status!='FAILED'",[p.paymentRequestId])).rows[0].amount;
    const allowed=BigInt(used)+BigInt(p.amountPaise)<=BigInt(payment.amount_paise);
    const status=!allowed||mode==='decline'?'FAILED':['ambiguous','temporary-failure'].includes(mode)?'UNKNOWN':'SUCCEEDED';
    row=(await client.query(`INSERT INTO mock_refunds(operation_id,payment_request_id,amount_paise,currency,status,provider_refund_id,failure_code) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[p.operationId,p.paymentRequestId,String(p.amountPaise),p.currency,status,status==='SUCCEEDED'?randomUUID():null,status==='FAILED'?(!allowed?'CAPACITY_CONFLICT':'PROVIDER_DECLINED'):null])).rows[0];
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  if(mode==='timeout')await new Promise(r=>setTimeout(r,delayMs));
  if(mode==='lost-response'){res.socket?.destroy();return;}res.json(view(row));
 });
 app.get('/refunds/:operationId',async(req,res)=>{
  const id=z.uuid().safeParse(req.params.operationId);if(!id.success){res.status(400).json({error:'Invalid refund operation'});return;}
  const row=(await pool.query('SELECT * FROM mock_refunds WHERE operation_id=$1',[id.data])).rows[0];res.json(row?view(row):{status:'UNKNOWN'});
 });
}
