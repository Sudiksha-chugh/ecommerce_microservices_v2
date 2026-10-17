import {z} from 'zod';
export const telemetryEvidenceSchema=z.strictObject({
 status:z.enum(['verified','unavailable']),scope:z.literal('phase17-sdk-in-process-export'),
 activatedAt:z.iso.datetime().nullable(),removedAt:z.iso.datetime().nullable(),recoveryDurationMs:z.number().int().nonnegative(),
 traces:z.array(z.strictObject({traceId:z.string().regex(/^(?!0+$)[a-f0-9]{32}$/),spanId:z.string().regex(/^(?!0+$)[a-f0-9]{16}$/),name:z.string().max(100)})).max(16),
 metrics:z.array(z.strictObject({name:z.enum(['resilience.scenarios','resilience.duration','business.observations','dependency.operation.duration','http.client.request.duration']),value:z.number().finite(),attributes:z.partialRecord(z.enum(['fault','target','outcome','operation','db.system.name','http.request.method']),z.union([z.string().max(50),z.number()]))})).max(16),
 reason:z.enum(['collected','sdk-unavailable','no-exported-trace','no-collected-metrics','missing-lifecycle']),
}).refine(v=>v.status!=='verified'||(v.activatedAt!==null&&v.removedAt!==null&&v.traces.length>0&&v.metrics.length>0&&v.reason==='collected'&&Date.parse(v.removedAt)>=Date.parse(v.activatedAt)),'Verified telemetry needs actual exports and lifecycle');
export type TelemetryEvidence=z.infer<typeof telemetryEvidenceSchema>;
