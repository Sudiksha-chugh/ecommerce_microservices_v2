import {describe,it,expect} from 'vitest';
import {sqlFingerprint,SqlTelemetryStore,sqlTelemetryConfig} from '../../src/sql-telemetry.js';
const config={enabled:true,sampleRatio:1,maxFingerprints:2,retentionMs:1000,slowMs:10};
describe('SQL fingerprint privacy and bounds',()=>{
 it.each([
  ["SELECT * FROM products WHERE name='alice-secret' AND price=12.5", "select * from products where name='bob-secret' and price=99.2"],
  ["SELECT E'password\\\'secret', $$private$$, $tag$customer$tag$, $1", "SELECT E'other', $$other$$, $tag$other$tag$, $999"],
  ['SELECT 123 /* nested /* secret */ comment */ -- hidden\nFROM products','select 456 from products'],
  ['SELECT "sensitive identifier", U&"private"','select "other", U&"other"'],
  ['SELECT 0xFF, 0b101, 0o777, 1e+3','SELECT 0xAA, 0b000, 0o123, 2e+5'],
 ])('groups literal variants without returning text',(a,b)=>{const fp=sqlFingerprint(a);expect(fp).toMatch(/^q_[a-f0-9]{24}$/);expect(fp).toBe(sqlFingerprint(b));});
 it.each(['SELECT \'unterminated','SELECT $$unterminated','SELECT /* unclosed','SELECT ☃','x'.repeat(8193),''])('fails closed for unsupported input %s',text=>expect(sqlFingerprint(text)).toBeUndefined());
 it('distinguishes query shapes and handles non-string inputs',()=>{expect(sqlFingerprint('SELECT id FROM products')).not.toBe(sqlFingerprint('SELECT name FROM products'));expect(sqlFingerprint({text:'private'})).toBeUndefined();});
 it('is disabled by default and invalid tuning cannot affect startup',()=>{expect(sqlTelemetryConfig().enabled).toBe(false);expect(sqlTelemetryConfig({OTEL_SQL_ENABLED:'true',OTEL_SQL_MAX_FINGERPRINTS:'50000'}).enabled).toBe(false);expect(sqlTelemetryConfig({OTEL_SQL_ENABLED:'true',OTEL_SQL_SAMPLE_RATIO:'0'}).sampleRatio).toBe(0);});
 it('caps cardinality, expires entries, and returns detached reports',()=>{let now=100;const s=new SqlTelemetryStore(config,()=>now,()=>0);s.begin('SELECT a','SELECT')!.finish(20,false);s.begin('SELECT b','SELECT')!.finish(5,true);expect(s.begin('SELECT c','SELECT')).toBeUndefined();let snapshot=s.snapshot();expect(snapshot.queries).toHaveLength(2);expect(snapshot.dropped).toBe(1);snapshot.queries[0]!.histogram.fill(999);expect(s.snapshot().queries[0]!.histogram).not.toContain(999);now=1100;expect(s.snapshot().queries).toHaveLength(0);expect(s.begin('SELECT c','SELECT')).toBeDefined();});
 it('samples before fingerprint work, counts outcomes once and never retains input',()=>{const s=new SqlTelemetryStore(config,()=>100,()=>0);const observation=s.begin("SELECT 'sensitive'",'SELECT')!;observation.finish(11,true);observation.finish(20,false);const report=s.snapshot();expect(report.queries[0]).toMatchObject({sampledCount:1,errors:1,slow:1,totalMs:11,maxMs:11});expect(report.queries[0]!.histogram.reduce((a,b)=>a+b,0)).toBe(1);expect(JSON.stringify(report)).not.toContain('sensitive');const zero=new SqlTelemetryStore({...config,sampleRatio:0},()=>100,()=>0);expect(zero.begin('private','SELECT')).toBeUndefined();expect(zero.snapshot().queries).toEqual([]);});
});

it('rejects invalid storage bounds and cannot retain caller-provided label content',()=>{expect(()=>new SqlTelemetryStore({...config,maxFingerprints:100000})).toThrow();const mutable={...config};const s=new SqlTelemetryStore(mutable,()=>100,()=>0);mutable.maxFingerprints=100000;s.begin('SELECT 1','secret customer operation')!.finish(1,false);expect(s.snapshot().maxFingerprints).toBe(2);expect(s.snapshot().queries[0]!.operation).toBe('OTHER');expect(JSON.stringify(s.snapshot())).not.toContain('secret customer');});
