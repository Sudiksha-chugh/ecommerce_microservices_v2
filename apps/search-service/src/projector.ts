import { productProjectionSchema, verifyProducerEvent, PermanentHandlerError, type Event, type ProductProjection } from '@ecommerce/messaging';
import { Elasticsearch, IndexMissingError, InvalidProjectionError, SearchUnavailableError } from './elasticsearch.js';
import { SearchRepository } from './repository.js';
import { SearchMetrics } from './metrics.js';
export class Projector {
 constructor(readonly repository:SearchRepository,readonly elastic:Elasticsearch,readonly metrics=new SearchMetrics(),private readonly logger:(record:Record<string,unknown>)=>void=record=>console.info(JSON.stringify(record))){}
 private log(record:Record<string,unknown>){try{this.logger({component:'search-indexer',...record});}catch{/* Logs cannot change disposition. */}}
 async write(document:ProductProjection,indexes?:string[]){
  const parsed=productProjectionSchema.parse(document);await this.repository.remember(parsed);
  const latest=await this.repository.latest(parsed.id);if(!latest)throw new SearchUnavailableError();
  const targets=indexes?indexes.map(index_name=>({index_name,status:'EXPLICIT'})):await this.repository.targetStates();if(!targets.length)throw new SearchUnavailableError();
  for(const target of targets){try{await this.elastic.put(target.index_name,latest);}catch(error){
    if(error instanceof IndexMissingError&&target.status==='RETAINED'){
      await this.repository.pool.query("UPDATE search_targets SET status='LOST' WHERE index_name=$1 AND status='RETAINED'",[target.index_name]);continue;
    }throw error;
  }}
 }
 async consume(input:Event,key:string,retryCount=0){const start=performance.now();
  try{
   const event=verifyProducerEvent(input,key,'catalog-service');
   if(!event.eventType.startsWith('catalog.product.'))throw new PermanentHandlerError();
   const document=productProjectionSchema.parse((event.payload as {product:unknown}).product);
   await this.repository.receive(event,document);await this.write(document);await this.repository.complete(event.eventId);
   this.metrics.values.search_index_events_total++;this.metrics.values.search_projection_lag_seconds=Math.max(0,(Date.now()-Date.parse(event.occurredAt))/1000);
   this.log({eventId:event.eventId,correlationId:event.correlationId,productId:document.id,productVersion:document.productVersion,indexingDurationMs:performance.now()-start,retryCount,outcome:'indexed'});
  }catch(error){this.metrics.values.search_index_failures_total++;const permanent=error instanceof PermanentHandlerError||error instanceof InvalidProjectionError;
   this.log({eventId:input.eventId,retryCount,outcome:permanent?'permanent_failure':'transient_failure'});
   if(permanent)throw new PermanentHandlerError();throw error;
  }
 }
}
