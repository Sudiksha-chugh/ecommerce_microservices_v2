// Explicit slow isolated infrastructure exercise, separate from per-request test budgets.
import { searchFixture,eventKey,elasticProxy,until } from '../apps/search-service/test/fixture.ts';
import { Projector } from '../apps/search-service/src/projector.ts';
import { Elasticsearch } from '../apps/search-service/src/elasticsearch.ts';
import { RebuildCoordinator } from '../apps/search-service/src/rebuild.ts';
const f=await searchFixture();const result={project:f.project,shutdownDuringIndexing:false,catalogIndependent:false,restarted:false,rebuildRestored:false,tombstoneProtection:false,cleanup:false};let proxy;
try{
 const p=await f.products.create({name:'Restart headphones',description:'music',priceInPaise:1});const old=await f.event(p.id);
 proxy=await elasticProxy(f.elasticOrigin);const projector=new Projector(f.repository,new Elasticsearch(proxy.origin,f.alias,200));proxy.pause();
 const pending=projector.consume(old,eventKey).catch(error=>error);await proxy.captured();
 await f.docker(['stop','-t','0','elasticsearch']);if(!((await pending) instanceof Error))throw new Error('Expected ambiguous indexing failure');result.shutdownDuringIndexing=true;proxy.release();
 await f.products.delete(p.id);const created=await f.products.create({name:'Created while ES offline',description:'retained source',priceInPaise:2});
 if(await f.products.findById(p.id)||!await f.products.findById(created.id))throw new Error('Catalog failed during ES outage');result.catalogIndependent=true;
 await f.docker(['start','elasticsearch']);
 // Docker reallocates an empty/random HostPort binding on container start.
 const port=Number((await f.docker(['port','elasticsearch','9200'])).stdout.trim().split(':').at(-1));
 if(!port)throw new Error('Restarted Elasticsearch has no isolated host port');
 const elastic=new Elasticsearch(`http://127.0.0.1:${port}`,f.alias,2000);
 const recovery=new Projector(f.repository,elastic),coordinator=new RebuildCoordinator(f.repository,recovery,f.catalog,2);
 console.info(JSON.stringify({component:'search-restart',stage:'rediscovered_port',changed:port!==f.elasticPort}));
 const deadline=Date.now()+900000;
 while(Date.now()<deadline){if(await elastic.ready())break;await new Promise(resolve=>setTimeout(resolve,1000));}
 if(!await elastic.ready())throw new Error('Restarted isolated Elasticsearch never became ready');result.restarted=true;
 // Root readiness precedes mapping/index module readiness on a cold JVM.
 // Probe real commands under the unchanged application deadline before recovery.
 const warm=f.alias+'_restart_probe';
 await until(async()=>{try{await elastic.create(warm);await elastic.refresh(warm);return true;}catch{return false;}},60000);
 await elastic.request('DELETE',`/${warm}`);
 // tmpfs index loss is intentional here: source tombstones/journal rebuild current state.
 const requested=await f.repository.createJob('REBUILD','00000000-0000-4000-8000-000000000000');
 await until(async()=>{await coordinator.step(requested.id);return (await f.repository.job(requested.id))?.status==='COMPLETE';},10000);
 const job=(await f.repository.job(requested.id));if(!(await elastic.get(job.index_name,p.id))?.deleted||!await elastic.get(job.index_name,created.id))throw new Error('Rebuild did not recover source state');result.rebuildRestored=true;
 await recovery.consume(old,eventKey);if(!(await elastic.get(job.index_name,p.id))?.deleted)throw new Error('Old event resurrected deleted product');result.tombstoneProtection=true;
}finally{await proxy?.close();await f.close();await f.docker(['down','--remove-orphans']);result.cleanup=true;console.info(JSON.stringify(result));}
