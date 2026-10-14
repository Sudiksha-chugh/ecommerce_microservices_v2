import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {MessagingUnavailableError,PoisonMessageError,UnroutableMessageError,validateEvent,type Event} from '@ecommerce/messaging';
import {OutboxRepository,type Claim,type FailureCode} from './repository.js';
import {defaultLogger,log,type Logger} from '../common.js';
export const outboxSettings=z.object({batchSize:z.number().int().min(1).max(100).default(10),pollIntervalMs:z.number().int().min(50).max(60000).default(1000),leaseMs:z.number().int().min(100).max(300000).default(30000),maxAttempts:z.number().int().min(1).max(100).default(6),shutdownTimeoutMs:z.number().int().min(50).max(120000).default(10000)});
export const PUBLICATION_RETRY_DELAYS=[5000,30000,120000,300000,900000] as const;
export interface Publisher {publish(event:Event):Promise<void>}
export class OutboxWorker {
 readonly workerId:string;private stopped=false;private timer:ReturnType<typeof setTimeout>|undefined;private active:Promise<number>|undefined;private started=false;
 readonly settings:z.infer<typeof outboxSettings>;
 constructor(private readonly repository:OutboxRepository,private readonly publisher:Publisher,settings:z.input<typeof outboxSettings>={},private readonly logger:Logger=defaultLogger,private readonly clock:() => number=Date.now,private readonly retryDelay:(attempt:number) => number=(attempt) => PUBLICATION_RETRY_DELAYS[Math.min(Math.max(attempt-1,0),4)]!,workerId=randomUUID()){this.settings=outboxSettings.parse(settings);this.workerId=workerId;}
 async runOnce():Promise<number>{if(this.stopped)return 0;if(this.active)return this.active;this.active=this.run().finally(() => {this.active=undefined;});return this.active;}
 private async run(){let claims:Claim[];try{claims=await this.repository.claim(this.workerId,this.settings.batchSize,this.settings.leaseMs,this.settings.maxAttempts);}catch{log(this.logger,{component:'outbox',workerId:this.workerId,outcome:'database_claim_failed'});return 0;}
  // Claims are committed. Parallel bounded publication avoids batch positions consuming each other's leases.
  await Promise.all(claims.map(async (claim) => {
   if(this.stopped){try{await this.repository.release(claim);}catch{/* Lease expiry recovers it. */}return;}
   const began=this.clock();let event:Event|undefined;let confirmed=false;
   const fields=() => ({component:'outbox',eventId:claim.id,eventType:event?.eventType,correlationId:event?.correlationId,causationId:event?.causationId,workerId:this.workerId,claimToken:claim.claim_token,attemptNumber:claim.attempts,publicationLatencyMs:Math.max(0,this.clock()-began)});
   try{event=validateEvent(claim.envelope);await this.publisher.publish(event);confirmed=true;const stored=await this.repository.published(claim);log(this.logger,{...fields(),outcome:stored?'published':'stale_claim'});}
   catch(error){if(confirmed){log(this.logger,{...fields(),outcome:'confirmed_database_update_uncertain'});return;}
    const code:FailureCode=error instanceof PoisonMessageError?'INVALID_CONTRACT':error instanceof UnroutableMessageError?'UNROUTABLE':error instanceof MessagingUnavailableError&&error.reason==='CONFIGURATION'?'CONFIGURATION_FAILURE':'BROKER_UNAVAILABLE';
    const review=code==='INVALID_CONTRACT'||code==='UNROUTABLE'||code==='CONFIGURATION_FAILURE'||claim.attempts>=this.settings.maxAttempts;
    try{const delay=this.retryDelay(claim.attempts);if(!Number.isSafeInteger(delay)||delay<0||delay>900000)throw new Error('Invalid retry policy');const stored=await this.repository.failed(claim,code,delay,review);log(this.logger,{...fields(),outcome:stored?(review?'needs_attention':'retry_scheduled'):'stale_claim',failureClassification:code});}
    catch{log(this.logger,{...fields(),outcome:'database_failure_update_uncertain'});}
   }
  }));return claims.length;
 }
 start(){if(this.started||this.stopped)return;this.started=true;const tick=() => {void this.runOnce().catch(() => {log(this.logger,{component:'outbox',outcome:'worker_failed',workerId:this.workerId});}).finally(() => {if(!this.stopped){this.timer=setTimeout(tick,this.settings.pollIntervalMs);this.timer.unref();}});};tick();}
 async stop(){this.stopped=true;clearTimeout(this.timer);let deadline:ReturnType<typeof setTimeout>|undefined;await Promise.race([this.active,new Promise<void>((resolve) => {deadline=setTimeout(resolve,this.settings.shutdownTimeoutMs);})]);clearTimeout(deadline);}
}
