import {it,expect} from 'vitest';
import express from 'express';import request from 'supertest';
import {createJwtFixture} from '../../../../test/jwt-fixture.js';
import {PerformanceInvestigation} from '../../src/performance/engine.js';
import {performanceReporting} from '../../src/performance/api.js';
import {reportSchema,evidenceSchema} from '../../src/performance/schemas.js';
import {input,now,limits,collectors,metric} from './fixtures.js';
async function report(){return new PerformanceInvestigation(collectors(),limits,undefined,()=>now).analyze(input);}
it.each(['unknown_span','overlap','duration','service','partial_attribution','missing_priority','false_sql_link','unrequested_trace'] as const)('rejects tampered report %s',async mode=>{const r=structuredClone(await report()),t=r.traces[0]!;
 if(mode==='unknown_span')t.criticalPath[0]!.spanId='f'.repeat(16);
 if(mode==='overlap')t.criticalPath[1]!.startMs=t.criticalPath[0]!.startMs;
 if(mode==='duration')t.durationMs=999999;
 if(mode==='service')t.spans[0]!.service='catalog-service';
 if(mode==='partial_attribution')t.status='partial';
 if(mode==='missing_priority')r.priorities=[];
 if(mode==='false_sql_link')r.sqlLinks=[{sqlEvidenceId:r.evidence[0]!.evidenceId,spanEvidenceId:t.spans[0]!.evidenceId,relation:'validated_query_shape',limitations:['Not an execution association.']}];
 if(mode==='unrequested_trace')t.traceId='b'.repeat(32);
 expect(reportSchema.safeParse(r).success).toBe(false);
});
it.each(['reference','signal','trace_association','quality','ratio'] as const)('rejects false evidence provenance %s',mode=>{const e=metric();if(mode==='reference')e.reference='sql:q_'+ 'a'.repeat(24);if(mode==='signal')e.signal='queue_depth';if(mode==='trace_association')e.traceId='a'.repeat(32);if(mode==='quality')e.quality='approved_snapshot';if(mode==='ratio'){e.signal='http_errors';e.value=2;}expect(evidenceSchema.safeParse(e).success).toBe(false);});
it('validates the final response again at the HTTP boundary',async()=>{const jwt=await createJwtFixture(),engine=new PerformanceInvestigation(collectors(),limits,undefined,()=>now);engine.analyze=async()=>({...await report(),schemaVersion:99} as never);const app=express();app.use('/internal/performance',performanceReporting(jwt.verify,engine));const response=await request(app).post('/internal/performance/analyze').set('authorization','Bearer '+await jwt.sign()).send(input);expect(response.status).toBe(503);expect(JSON.stringify(response.body)).not.toContain('schemaVersion');});

// Real Tempo protobuf JSON omits zero-valued status codes. Unknown is not success.
it('accepts omitted OTLP status code without inventing success',async()=>{const {parseTrace}=await import('../../src/performance/traces.js'),{traceResponse,traceId}=await import('./fixtures.js');const raw=traceResponse();for(const batch of raw.batches)for(const group of batch.scopeSpans)for(const s of group.spans)Object.assign(s,{status:{},kind:'SPAN_KIND_INTERNAL'});const parsed=parseTrace(raw,traceId,input,limits);expect(parsed.spans).toHaveLength(3);expect(parsed.spans.every(s=>s.error===null&&s.kind==='internal')).toBe(true);});

it('keeps serialized reports within the limit including cache freshness fields',async()=>{const first=await report(),maximum=Buffer.byteLength(JSON.stringify(first))+5;const engine=new PerformanceInvestigation(collectors(),{...limits,reportBytes:maximum},undefined,()=>now);for(let i=0;i<2;i++)expect(Buffer.byteLength(JSON.stringify(await engine.analyze(input)))).toBeLessThanOrEqual(maximum);});
it('rejects an oversized final HTTP report even from a faulty engine',async()=>{const jwt=await createJwtFixture(),large=await report(),engine=new PerformanceInvestigation(collectors(),{...limits,reportBytes:4096},undefined,()=>now);expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(4096);engine.analyze=async()=>large;const app=express();app.use('/internal/performance',performanceReporting(jwt.verify,engine));await request(app).post('/internal/performance/analyze').set('authorization','Bearer '+await jwt.sign()).send(input).expect(503);});
