import {metrics} from '@opentelemetry/api';
import {enabled} from '../context.js';
import {sourceSchema} from './schemas.js';
function create(){const m=metrics.getMeter('ecommerce.performance-investigation','1');return {request:m.createCounter('performance_investigation_requests_total'),duration:m.createHistogram('performance_investigation_duration_seconds',{unit:'s'}),source_failure:m.createCounter('performance_investigation_source_failures_total'),partial:m.createCounter('performance_investigation_partial_reports_total'),ai_failure:m.createCounter('performance_investigation_ai_failures_total'),inflight:m.createUpDownCounter('performance_investigation_inflight_requests')};}
let instruments:ReturnType<typeof create>|undefined;
export function performanceMetric(event:keyof ReturnType<typeof create>,value=1,source?:string){if(!enabled()||!Number.isFinite(value))return;try{const attributes=source&&sourceSchema.safeParse(source).success?{source}:{};const all=instruments??=create();if(event==='duration')all.duration.record(value,attributes);else all[event].add(value,attributes);}catch{/* Diagnostic instrumentation cannot affect an investigation outcome. */}}
