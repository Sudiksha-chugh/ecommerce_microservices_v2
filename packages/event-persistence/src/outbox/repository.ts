import {captureEventContext} from '@ecommerce/observability';
import type {Pool,PoolClient} from 'pg';
import {routingKey,validateEvent,type Event} from '@ecommerce/messaging';
import {transaction} from '../common.js';
export interface Claim {id:string;envelope:unknown;claim_token:string;locked_by:string;attempts:number;total_attempts:number}
export type FailureCode='BROKER_UNAVAILABLE'|'UNROUTABLE'|'INVALID_CONTRACT'|'CONFIGURATION_FAILURE';
// Caller supplies its existing business transaction client. Never acquires a separate connection.
export async function insertOutbox(client:PoolClient,input:Event,aggregateId?:string){
 const event=validateEvent(input);captureEventContext(event.eventId);
 await client.query(`INSERT INTO outbox_events (id,aggregate_id,event_type,event_version,routing_key,producer,occurred_at,payload,envelope,correlation_id,causation_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,[event.eventId,aggregateId??null,event.eventType,event.eventVersion,routingKey(event),event.producer,event.occurredAt,JSON.stringify(event.payload),JSON.stringify(event),event.correlationId,event.causationId]);
}
export class OutboxRepository {
 constructor(private readonly pool:Pool){}
 async claim(workerId:string,batchSize:number,leaseMs:number,maxAttempts:number):Promise<Claim[]>{
  return transaction(this.pool,async (client) => {
   // Exhausted crash leases are retained for operator review, never deleted.
   await client.query(`WITH exhausted AS (SELECT id FROM outbox_events WHERE attempts >= $1 AND
    (status='PENDING' OR (status='PROCESSING' AND locked_until <= clock_timestamp())) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
    UPDATE outbox_events e SET status='NEEDS_ATTENTION',locked_by=NULL,locked_until=NULL,claim_token=NULL,last_error='LEASE_EXHAUSTED',updated_at=clock_timestamp()
    FROM exhausted WHERE e.id=exhausted.id`,[maxAttempts,batchSize]);
   return (await client.query<Claim>(`WITH eligible AS (SELECT id FROM outbox_events WHERE attempts < $4 AND
    ((status='PENDING' AND next_attempt_at <= clock_timestamp()) OR (status='PROCESSING' AND locked_until <= clock_timestamp()))
    ORDER BY next_attempt_at,created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
    UPDATE outbox_events e SET status='PROCESSING',attempts=e.attempts+1,total_attempts=e.total_attempts+1,
    locked_by=$1,locked_until=clock_timestamp()+$3::integer*INTERVAL '1 millisecond',claim_token=gen_random_uuid(),updated_at=clock_timestamp()
    FROM eligible WHERE e.id=eligible.id RETURNING e.id,e.envelope,e.claim_token,e.locked_by,e.attempts,e.total_attempts`,[workerId,batchSize,leaseMs,maxAttempts])).rows;
  });
 }
 async published(claim:Claim):Promise<boolean>{return (await this.pool.query(`UPDATE outbox_events SET status='PUBLISHED',published_at=clock_timestamp(),
  locked_by=NULL,locked_until=NULL,claim_token=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1 AND claim_token=$2 AND status='PROCESSING'`,[claim.id,claim.claim_token])).rowCount===1;}
 async failed(claim:Claim,code:FailureCode,delayMs:number,review:boolean):Promise<boolean>{return (await this.pool.query(`UPDATE outbox_events
  SET status=$3,next_attempt_at=clock_timestamp()+$4::integer*INTERVAL '1 millisecond',last_error=$5,publication_failures=publication_failures+1,
  locked_by=NULL,locked_until=NULL,claim_token=NULL,updated_at=clock_timestamp() WHERE id=$1 AND claim_token=$2 AND status='PROCESSING'`,[claim.id,claim.claim_token,review?'NEEDS_ATTENTION':'PENDING',delayMs,code])).rowCount===1;}
 async release(claim:Claim):Promise<boolean>{return (await this.pool.query(`UPDATE outbox_events SET status='PENDING',locked_by=NULL,locked_until=NULL,claim_token=NULL,updated_at=clock_timestamp()
 WHERE id=$1 AND claim_token=$2 AND status='PROCESSING'`,[claim.id,claim.claim_token])).rowCount===1;}
 async requeue(id:string):Promise<boolean>{return transaction(this.pool,async (client) => {const row=(await client.query<{envelope:unknown}>('SELECT envelope FROM outbox_events WHERE id=$1 AND status=\'NEEDS_ATTENTION\' FOR UPDATE',[id])).rows[0];if(!row)return false;validateEvent(row.envelope);await client.query("UPDATE outbox_events SET status='PENDING',attempts=0,next_attempt_at=clock_timestamp(),last_error=NULL,requeue_count=requeue_count+1,updated_at=clock_timestamp() WHERE id=$1",[id]);return true;});}
 async stats(){return (await this.pool.query(`SELECT COUNT(*) FILTER (WHERE status='PENDING')::integer AS pending,
  COUNT(*) FILTER (WHERE status='PUBLISHED')::integer AS published,COUNT(*) FILTER (WHERE status='NEEDS_ATTENTION')::integer AS attention,
  COUNT(*) FILTER (WHERE status='PROCESSING' AND locked_until<=clock_timestamp())::integer AS expired_leases,
  COALESCE(SUM(publication_failures),0)::text AS failed_attempts,
  EXTRACT(EPOCH FROM clock_timestamp()-MIN(created_at) FILTER (WHERE status IN ('PENDING','PROCESSING'))) AS oldest_pending_seconds FROM outbox_events`)).rows[0];}
}
