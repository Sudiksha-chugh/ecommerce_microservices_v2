import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {InMemorySpanExporter} from '@opentelemetry/sdk-trace-base';
import {InMemoryMetricExporter,PeriodicExportingMetricReader,AggregationTemporality} from '@opentelemetry/sdk-metrics';
import {initializeTelemetry} from '../../bootstrap.mjs';
import {instrumentPg,sqlTelemetrySnapshot,operation,correlation} from '../../src/index.js';
const spans=new InMemorySpanExporter(),exporter=new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
let state:Awaited<ReturnType<typeof initializeTelemetry>>;const old={...process.env};
beforeAll(async()=>{process.env.OTEL_SQL_ENABLED='true';process.env.OTEL_SQL_SAMPLE_RATIO='1';process.env.OTEL_SQL_SLOW_MS='1';state=await initializeTelemetry({OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'sql-test',OTEL_TRACES_SAMPLER_ARG:'1'},{spanExporter:spans,metricReader:new PeriodicExportingMetricReader({exporter,exportIntervalMillis:10000})});});
afterAll(async()=>{await state.shutdown();process.env=old;});
it('preserves promises, values, error identity, arguments and transaction release',async()=>{
 const result={rows:[{secret:'not exported'}]},error=new Error('password=private SQL');const query=vi.fn(async(...args:unknown[])=>{if(args[0]==='ROLLBACK')throw error;return result;});const release=vi.fn();const client={query,release};const pool=instrumentPg({query,connect:async()=>client});
 expect(await pool.query("SELECT 'sensitive literal'",['private parameter'])).toBe(result);expect(query).toHaveBeenCalledWith("SELECT 'sensitive literal'",['private parameter']);const acquired=await pool.connect();expect(await acquired.query('BEGIN')).toBe(result);await expect(acquired.query('ROLLBACK')).rejects.toBe(error);acquired.release();expect(release).toHaveBeenCalledOnce();
});
it('preserves callback return, full argument order, context and exactly-once observations',async()=>{
 const result={rows:[]},release=()=>{},sentinel={};let parent:string|undefined;let seen:string|undefined;
 await operation('caller',{},async()=>{parent=correlation().spanId;const client=instrumentPg({query:(...args:unknown[])=>{(args.at(-1) as Function)(null,result,release);return sentinel;}});const callback=vi.fn((...values:unknown[])=>{seen=correlation().spanId;expect(values).toEqual([null,result,release]);});expect(client.query({text:'SELECT $1::text',values:['customer-secret']},callback)).toBe(sentinel);expect(callback).toHaveBeenCalledOnce();});expect(seen).toBe(parent);
});
it('retains synchronous throw identity and failures do not change later business calls',async()=>{
 const error=new Error('credential-secret');const bad=instrumentPg({query:()=>{throw error;}});expect(()=>bad.query()).toThrow(error);const good=instrumentPg({query:async()=>42});expect(await good.query()).toBe(42);
});
it('exports real counts, histogram, errors and slow observations with bounded operation labels only',async()=>{
 const client=instrumentPg({query:async(_sql:string)=>{await new Promise(r=>setTimeout(r,5));return 1;}});await client.query('SELECT 928371');await state.flush();const all=exporter.getMetrics().flatMap(m=>m.scopeMetrics.flatMap(s=>s.metrics)).filter(m=>m.descriptor.name.startsWith('sql.query.'));expect(new Set(all.map(m=>m.descriptor.name))).toEqual(new Set(['sql.query.executions','sql.query.duration','sql.query.errors','sql.query.slow']));for(const m of all)for(const p of m.dataPoints)expect(Object.keys(p.attributes)).toEqual(['operation']);expect(JSON.stringify({metrics:all,spans:spans.getFinishedSpans().map(s=>({attributes:s.attributes,events:s.events,status:s.status})),report:sqlTelemetrySnapshot()})).not.toMatch(/sensitive literal|private parameter|customer-secret|credential-secret|password=private|928371|not exported/);expect(sqlTelemetrySnapshot().queries.some(q=>q.errors>0)).toBe(true);expect(sqlTelemetrySnapshot().queries.some(q=>q.slow>0)).toBe(true);
});
