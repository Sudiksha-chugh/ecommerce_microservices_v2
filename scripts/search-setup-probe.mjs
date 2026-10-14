// Runs only dependency/fixture initialization and cleanup; no integration cases are filtered or skipped.
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Client } from 'pg';
import { querySchema, searchBody } from '../apps/search-service/src/query.ts';
import { searchFixture, eventKey } from '../apps/search-service/test/fixture.ts';
import { isolatedRedis } from '../packages/rate-limiting/test/fixture.ts';
import { errorCode, setupDiagnostics } from '../apps/search-service/test/setup-diagnostics.ts';
if (process.versions.node.split('.')[0] !== '24' || !process.env.INTEGRATION_ENV_DIR) throw new Error('Setup probe requires the isolated Node 24 runner');
const report = { runtime: process.version, setup: 'unexecuted', cleanup: 'unexecuted' };
const mode = process.env.INTEGRATION_PROBE_MODE ?? 'setup';
if (!['setup', 'single', 'latency'].includes(mode)) throw new Error('Unknown Search probe mode');
const diagnostics = setupDiagnostics(() => ({}));
let search, redis;
try {
  const results = await Promise.allSettled([
    searchFixture(),
    diagnostics.stage('REDIS_READY', 'redis', async () => {
      const fixture = await isolatedRedis();
      redis = fixture;
      if (await fixture.client.ping() !== 'PONG') throw new Error('Redis PING failed');
      return fixture;
    }),
  ]);
  if (results[0].status === 'fulfilled') search = results[0].value;
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  report.setup = 'passed';
  if (mode === 'latency') {
    report.assertions='running';
    report.measurements = [];
    const measure = async (name, action) => {
      const start = performance.now();
      try { await action(); report.measurements.push({ name, durationMs: performance.now()-start, outcome:'ok' }); }
      catch(error) { report.measurements.push({ name, durationMs: performance.now()-start, outcome:'failed', code:errorCode(error) }); throw error; }
    };
    for (const [database, url, pool] of [['catalog',search.catalogUrl,search.catalogPool],['search',search.searchUrl,search.searchPool]]) {
      // Numeric loopback endpoints exclude DNS lookup; TCP event precedes completed authentication.
      assert.equal(new URL(url).hostname,'127.0.0.1');
      const fresh = async label => {
        const client = new Client({connectionString:url,connectionTimeoutMillis:2000,statement_timeout:5000});
        const start=performance.now();
        client.connection.stream.once('connect',()=>report.measurements.push({name:database+'_'+label+'_TCP',durationMs:performance.now()-start,outcome:'ok'}));
        try { await measure(database+'_'+label+'_CONNECT_AUTH',()=>client.connect()); await measure(database+'_'+label+'_QUERY',()=>client.query('SELECT 1')); }
        finally { await client.end(); }
      };
      for(let i=0;i<3;i++)await fresh('fresh_sequential_'+i);
      const parallel=await Promise.allSettled(Array.from({length:5},(_,i)=>fresh('fresh_concurrent_'+i)));
      const failed=parallel.filter(result=>result.status==='rejected');if(failed.length)throw new AggregateError(failed.map(result=>result.reason),'Concurrent PostgreSQL probe failed');
      const reused=async label=>{let client;try{await measure(database+'_'+label+'_ACQUIRE',async()=>{client=await pool.connect();});await measure(database+'_'+label+'_QUERY',()=>client.query('SELECT 1'));}finally{client?.release();}};
      for(let i=0;i<3;i++)await reused('pool_sequential_'+i);
      const pooled=await Promise.allSettled(Array.from({length:5},(_,i)=>reused('pool_concurrent_'+i)));
      const errors=pooled.filter(result=>result.status==='rejected');if(errors.length)throw new AggregateError(errors.map(result=>result.reason),'Concurrent pool probe failed');
    }
    const query=()=>search.elastic.search(searchBody(querySchema.parse({q:'latency',limit:20}))).then(result=>assert.equal(result.timed_out,false));
    for(let i=0;i<3;i++)await measure('elastic_warm_sequential_'+i,query);
    const responses=await Promise.allSettled(Array.from({length:3},(_,i)=>measure('elastic_warm_concurrent_'+i,query)));
    const failed=responses.filter(result=>result.status==='rejected');if(failed.length)throw new AggregateError(failed.map(result=>result.reason),'Concurrent Elasticsearch probe failed');
    report.assertions='passed';
  }
  if (mode === 'single') {
    report.assertions = 'running';
    await diagnostics.stage('SEARCH_SINGLE_TEST', 'catalog-search-elasticsearch', async () => {
      const product = await search.products.create({ name: 'Setup recovery headphones', description: 'Representative searchable product', priceInPaise: 249900 });
      await search.projector.consume(await search.event(product.id), eventKey);
      const targets = await search.elastic.current();
      assert.equal(targets.length, 1);
      await search.elastic.refresh(targets[0]);
      const response = await request(search.app).get('/search/products?q=headphones');
      report.httpStatus = response.status;
      assert.equal(response.status, 200);
      assert.equal(response.body.data.length, 1);
      assert.equal(response.body.data[0].id, product.id);
      assert.equal(response.body.data[0].priceInPaise, 249900);
    });
    report.assertions = 'passed';
  }
} catch (error) {
  if (report.setup !== 'passed') report.setup = 'failed';
  if (report.assertions === 'running') report.assertions = 'failed';
  if(error instanceof AggregateError && /setup and cleanup/.test(error.message))report.cleanup='failed';
  report.code = errorCode(error);
  if (error instanceof assert.AssertionError && typeof error.actual === 'number' && typeof error.expected === 'number') { report.actual = error.actual; report.expected = error.expected; }
  process.exitCode = 1;
} finally {
  try { await redis?.close(); await search?.close(); if(report.cleanup!=='failed')report.cleanup = 'passed'; }
  catch (error) { report.cleanup = 'failed'; report.cleanupCode = errorCode(error); process.exitCode = 1; }
  console.log(JSON.stringify({ component: 'search-setup-probe', ...report }));
  if (process.env.INTEGRATION_PROBE_REPORT) await writeFile(process.env.INTEGRATION_PROBE_REPORT, JSON.stringify(report, null, 2) + '\n');
}
