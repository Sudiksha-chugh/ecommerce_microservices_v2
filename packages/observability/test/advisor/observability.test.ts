import {it,expect} from 'vitest';
import {InMemorySpanExporter} from '@opentelemetry/sdk-trace-base';
import {InMemoryMetricExporter,PeriodicExportingMetricReader,AggregationTemporality} from '@opentelemetry/sdk-metrics';
import {initializeTelemetry} from '../../bootstrap.mjs';
it('exports fixed metric labels, sanitized spans and safe structured failure logs',async()=>{
 const spans=new InMemorySpanExporter(),exporter=new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
 const state=await initializeTelemetry({OTEL_ENABLED:'true',OTEL_SERVICE_NAME:'advisor-test',OTEL_TRACES_SAMPLER_ARG:'1'},{spanExporter:spans,metricReader:new PeriodicExportingMetricReader({exporter,exportIntervalMillis:10000})});
 const {SqlAdvisor,advisorConfig}=await import('../../src/sql-advisor.js');
 const original=console.info,logs:string[]=[];console.info=(v:string)=>{logs.push(v);};
 try{
  const advisor=new SqlAdvisor({...advisorConfig({}),enabled:true},{identity:'test',analyze:async()=>{throw Error('secret-private-value');}});
  const fingerprint='q_'+'a'.repeat(24);await advisor.analyze({version:1,fingerprint,operation:'SELECT',sampledCount:0,p95UpperMs:null,maxMs:0,plan:[]});await state.flush();
  const data=exporter.getMetrics().flatMap(m=>m.scopeMetrics.flatMap(s=>s.metrics)).filter(m=>m.descriptor.name.startsWith('sql_advisor_'));
  expect(data.map(m=>m.descriptor.name)).toEqual(expect.arrayContaining(['sql_advisor_requests_total','sql_advisor_provider_errors_total','sql_advisor_fallback_total','sql_advisor_inflight_requests','sql_advisor_analysis_duration_seconds']));
  for(const metric of data)for(const point of metric.dataPoints)expect(Object.keys(point.attributes).every(k=>k==='reason')).toBe(true);
  const serialized=JSON.stringify({data,spans:spans.getFinishedSpans().map(s=>({name:s.name,attributes:s.attributes,events:s.events})),logs});expect(serialized).not.toContain(fingerprint);expect(serialized).not.toContain('secret-private-value');expect(logs).toEqual([JSON.stringify({component:'sql-advisor',outcome:'enrichment_failed',reason:'unavailable'})]);expect(spans.getFinishedSpans().some(s=>s.name==='sql-advisor.analyze')).toBe(true);
 }finally{console.info=original;await state.shutdown();}
});
