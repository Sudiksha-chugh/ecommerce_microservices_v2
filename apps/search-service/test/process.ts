// Real subprocess crash checkpoints live only in test fixtures.
import { Pool } from 'pg';
import { Messaging, type Event } from '@ecommerce/messaging';
import { SearchRepository } from '../src/repository.js';
import { Elasticsearch } from '../src/elasticsearch.js';
import { Projector } from '../src/projector.js';
import { CatalogClient } from '../src/catalog-client.js';
import { RebuildCoordinator } from '../src/rebuild.js';
const pool=new Pool({connectionString:process.env.TEST_SEARCH_URL,max:5});pool.on('error',()=>{});
const repository=new SearchRepository(pool,process.env.TEST_ALIAS!);const elastic=new Elasticsearch(process.env.TEST_ELASTIC_URL!,process.env.TEST_ALIAS!);const projector=new Projector(repository,elastic);
async function checkpoint(label:string){process.send?.({checkpoint:label});await new Promise<void>(()=>{});}
if(process.env.TEST_OPERATION==='rebuild'){
 const coordinator=new RebuildCoordinator(repository,projector,new CatalogClient(process.env.TEST_CATALOG_URL!,process.env.TEST_LOOKUP_KEY!),2);
 const jobId=process.env.TEST_JOB_ID!;
 while(true){const job=(await repository.job(jobId))!;if(job.status==='SWAPPING'){
  if(process.env.TEST_CHECKPOINT==='before-alias')await checkpoint('before-alias');
  await elastic.refresh(job.index_name);await elastic.swap(job.index_name);await checkpoint('after-alias');
 }await coordinator.step(jobId);}
}else{
 const manager=new Messaging({url:process.env.TEST_BROKER_URL!,queues:['search.product-events.v1'],retryDelays:[20,40,80]},['search'],()=>{});
 manager.register('search.product-events.v1',async(event:Event)=>{
  if(process.env.TEST_CHECKPOINT==='before-index')await checkpoint('before-index');
  if(process.env.TEST_CHECKPOINT==='after-index'){await projector.write((event.payload as {product:Parameters<Projector['write']>[0]}).product);await checkpoint('after-index');}
  await projector.consume(event,process.env.TEST_EVENT_KEY!);await checkpoint('before-ack');
 });manager.start();const timer=setInterval(()=>{if(manager.status==='ready'){clearInterval(timer);process.send?.({checkpoint:'ready'});}},10);
}
