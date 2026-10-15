import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {validateEvent,type Event,PermanentHandlerError} from '@ecommerce/messaging';
import {defaultLogger,log,type Logger,PersistenceError} from '../common.js';
function canonical(value:unknown):unknown{if(Array.isArray(value))return value.map(canonical);if(typeof value==='object'&&value!==null)return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)]));return value;}
export class InboxProcessor {
 readonly counters={processed:0,duplicates:0,failures:0};
 constructor(private readonly pool:Pool,private readonly logger:Logger=defaultLogger,private readonly clock:() => number=Date.now){}
 async process(consumerName:string,input:Event,effect:(client:PoolClient,event:Event) => Promise<void>,signal?:AbortSignal):Promise<'processed'|'duplicate'>{
  z.string().min(1).max(255).parse(consumerName);const event=validateEvent(input);const fingerprint=createHash('sha256').update(JSON.stringify(canonical(event))).digest('hex');const began=this.clock();
  const fields=() => ({component:'inbox',eventId:event.eventId,eventType:event.eventType,correlationId:event.correlationId,causationId:event.causationId,consumer:consumerName,processingDurationMs:Math.max(0,this.clock()-began)});
  let client:PoolClient;try{client=await this.pool.connect();}catch{this.counters.failures++;log(this.logger,{...fields(),outcome:'database_failed'});throw new PersistenceError();}let broken=false;
 const onClientError = () => { broken = true; }; client.on('error', onClientError);
  try{await client.query('BEGIN');if(signal?.aborted)throw new PersistenceError();
   const inserted=await client.query(`INSERT INTO inbox_events (consumer_name,event_id,event_type,event_version,correlation_id,causation_id,event_fingerprint)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (consumer_name,event_id) DO NOTHING RETURNING event_id`,[consumerName,event.eventId,event.eventType,event.eventVersion,event.correlationId,event.causationId,fingerprint]);
   if(inserted.rowCount===0){const existing=(await client.query<{event_fingerprint:string}>('SELECT event_fingerprint FROM inbox_events WHERE consumer_name=$1 AND event_id=$2',[consumerName,event.eventId])).rows[0];if(existing?.event_fingerprint!==fingerprint)throw new PermanentHandlerError();await client.query('COMMIT');this.counters.duplicates++;log(this.logger,{...fields(),outcome:'duplicate'});return 'duplicate';}
   await effect(client,event);if(signal?.aborted)throw new PersistenceError();await client.query('COMMIT');this.counters.processed++;log(this.logger,{...fields(),outcome:'processed'});return 'processed';
  }catch(error){try{await client.query('ROLLBACK');}catch{broken=true;}this.counters.failures++;log(this.logger,{...fields(),outcome:'rolled_back_or_uncertain'});if(error instanceof PermanentHandlerError)throw error;throw new PersistenceError();}
  finally{client.release(broken); client.off('error', onClientError);}
 }
}
