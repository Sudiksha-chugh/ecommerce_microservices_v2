import { createHash } from 'node:crypto';
import { z } from 'zod';
export const services = ['api-gateway', 'auth-service', 'catalog-service', 'cart-service', 'orders-service', 'payments-service', 'inventory-service', 'notification-service', 'search-service'] as const;
export const serviceSchema = z.enum(services);
export type Service = z.infer<typeof serviceSchema>;
export const sourceSchema = z.enum(['metrics', 'traces', 'logs']);
export type Source = z.infer<typeof sourceSchema>;
export const timestamp = z.iso.datetime({ offset: true });
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const requestSchema = z.object({ incidentId: id, startTime: timestamp, endTime: timestamp, services: z.array(serviceSchema).min(1).max(9).refine(v => new Set(v).size === v.length), traceId: z.string().regex(/^[a-f0-9]{32}$/).refine(v => !/^0+$/.test(v)).optional() }).strict().superRefine((v, ctx) => { const d = Date.parse(v.endTime) - Date.parse(v.startTime); if (d <= 0 || d > 3600000)
    ctx.addIssue({ code: 'custom', message: 'Window must be positive and at most one hour' }); });
export type Investigation = z.infer<typeof requestSchema>;
export const signalSchema = z.enum(['http_errors', 'http_latency', 'throughput', 'database_latency', 'retries', 'business_failures', 'span_error', 'span_slow', 'dependency_failure', 'queue_backlog', 'service_unavailable']);
export type Signal = z.infer<typeof signalSchema>;
export const level = z.enum(['low', 'medium', 'high']);
export const safeText = z.string().min(1).max(500).refine(s => !/[\x00-\x1f`]|https?:|Bearer |@|\b(?:password|secret|token|SELECT|INSERT|DELETE|UPDATE|curl|kubectl|ignore.*instructions)\b/i.test(s));
export const evidenceSchema = z.object({ evidenceId: z.string().regex(/^e_[a-f0-9]{24}$/), source: sourceSchema, service: serviceSchema, startTime: timestamp, endTime: timestamp, signal: signalSchema, value: z.number().finite().min(0).max(1e15), baseline: z.number().finite().min(0).max(1e15).optional(), observation: safeText, reference: z.string().regex(/^(?:prometheus:[a-z_]+|tempo:[a-f0-9]{32}:[a-f0-9]{16}|snapshot:[a-f0-9]{24})$/), relatedService: serviceSchema.optional(), traceId: z.string().regex(/^[a-f0-9]{32}$/).optional(), spanId: z.string().regex(/^[a-f0-9]{16}$/).optional(), parentSpanId: z.string().regex(/^[a-f0-9]{16}$/).optional(), collectionStatus: z.literal('collected'), quality: z.enum(['measured', 'snapshot']), sanitization: z.literal('allowlisted') }).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24); }
export function evidence(value: Omit<Evidence, 'evidenceId' | 'sanitization' | 'collectionStatus'>): Evidence { return evidenceSchema.parse({ ...value, evidenceId: 'e_' + digest(value), sanitization: 'allowlisted', collectionStatus: 'collected' }); }
export const statusSchema = z.enum(['available', 'partial', 'unavailable']);
export const reasonSchema = z.enum(['ok', 'disabled', 'trace_id_required', 'unsupported', 'empty', 'timeout', 'unavailable', 'invalid_response', 'oversized', 'truncated', 'missing_series', 'outside_window']);
export const collectionSchema = z.object({ source: sourceSchema, status: statusSchema, reason: reasonSchema, collectedAt: timestamp, evidence: z.array(evidenceSchema).max(256) }).strict();
export type Collection = z.infer<typeof collectionSchema>;
export const edgeSchema = z.object({ from: serviceSchema, to: serviceSchema, kind: z.enum(['static', 'observed', 'hypothesized']), evidenceIds: z.array(z.string()).max(256) }).strict();
export type Edge = z.infer<typeof edgeSchema>;
const refs = z.array(z.string().regex(/^e_[a-f0-9]{24}$/)).max(256);
export const findingSchema = z.object({ findingId: z.string().regex(/^f_[a-f0-9]{24}$/), category: z.union([signalSchema, z.literal('multi_service_degradation')]), severity: level, confidence: level, affectedServices: z.array(serviceSchema).min(1).max(9), evidenceIds: refs.min(1), explanation: safeText, limitations: z.array(safeText).max(8), classification: z.literal('observed_symptom') }).strict();
export type Finding = z.infer<typeof findingSchema>;
export const hypothesisSchema = z.object({ hypothesisId: z.string().regex(/^h_[a-f0-9]{24}$/), candidateComponent: serviceSchema, classification: z.literal('root_cause_hypothesis'), supportingEvidenceIds: refs.min(1), contradictingEvidenceIds: refs, confidence: level, reasoningSummary: safeText, missingEvidence: z.array(safeText).min(1).max(8), validationSteps: z.array(safeText).min(1).max(8) }).strict();
export type Hypothesis = z.infer<typeof hypothesisSchema>;
export const reportSchema = z.object({ schemaVersion: z.literal(1), incidentId: id, status: z.enum(['analyzed', 'partial']), summary: safeText, severity: level, affectedServices: z.array(serviceSchema).max(9), timeWindow: z.object({ start: timestamp, end: timestamp }).strict(), analysisTimestamp: timestamp, analysisMode: z.enum(['deterministic', 'ai_enriched']), aiStatus: z.enum(['disabled', 'success', 'timeout', 'unavailable', 'invalid_response', 'budget', 'circuit_open']), observations: z.array(evidenceSchema).max(256), findings: z.array(findingSchema).max(64), rootCauseHypotheses: z.array(hypothesisSchema).max(9), recommendedActions: z.array(safeText).max(12), dependencies: z.array(edgeSchema).max(100), coverage: z.object({ metrics: statusSchema, traces: statusSchema, logs: statusSchema }).strict(), sourceStatuses: z.array(collectionSchema.omit({ evidence: true })).length(3), freshness: z.object({ snapshotVersion: z.string().regex(/^[a-f0-9]{24}$/), collectedAt: timestamp, latestEvidenceAt: timestamp.nullable(), stale: z.boolean(), cache: z.enum(['miss', 'hit', 'deduplicated']), cacheExpiresAt: timestamp.nullable() }).strict(), limitations: z.array(safeText).max(32) }).strict().superRefine((r, ctx) => { if (new Set(r.sourceStatuses.map(s => s.source)).size !== 3 || r.sourceStatuses.some(s => r.coverage[s.source] !== s.status))
    ctx.addIssue({ code: 'custom', message: 'Coverage mismatch' }); if (Date.parse(r.timeWindow.start) >= Date.parse(r.timeWindow.end))
    ctx.addIssue({ code: 'custom', message: 'Invalid report window' }); const ids = new Set(r.observations.map(e => e.evidenceId)); if (ids.size !== r.observations.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate evidence' }); for (const f of r.findings)
    for (const id of f.evidenceIds)
        if (!ids.has(id))
            ctx.addIssue({ code: 'custom', message: 'Unknown evidence' }); for (const h of r.rootCauseHypotheses)
    for (const id of [...h.supportingEvidenceIds, ...h.contradictingEvidenceIds])
        if (!ids.has(id))
            ctx.addIssue({ code: 'custom', message: 'Unknown hypothesis evidence' }); for (const edge of r.dependencies) {
    if (edge.kind === 'observed' && !edge.evidenceIds.length)
        ctx.addIssue({ code: 'custom', message: 'Observed edge needs evidence' });
    for (const id of edge.evidenceIds)
        if (!ids.has(id))
            ctx.addIssue({ code: 'custom', message: 'Unknown dependency evidence' });
} if (r.sourceStatuses.some(s => s.status !== 'available') && r.status !== 'partial')
    ctx.addIssue({ code: 'custom', message: 'Incomplete coverage must be partial' }); });
export type Report = z.infer<typeof reportSchema>;
export const limitsSchema = z.object({ windowMs: z.number().int().min(1000).max(3600000), services: z.number().int().min(1).max(9), metricSamples: z.number().int().min(1).max(10000), traceSpans: z.number().int().min(1).max(1000), logRecords: z.number().int().min(1).max(256), evidenceRecords: z.number().int().min(1).max(256), evidenceBytes: z.number().int().min(1024).max(262144), responseBytes: z.number().int().min(1024).max(2097152), backendTimeoutMs: z.number().int().min(10).max(5000), durationMs: z.number().int().min(50).max(30000), concurrent: z.number().int().min(1).max(4), cacheEntries: z.number().int().min(0).max(128), cacheTtlMs: z.number().int().min(0).max(60000), staleMs: z.number().int().min(1000).max(86400000), skewMs: z.number().int().min(0).max(60000), requestsPerMinute: z.number().int().min(1).max(120) }).strict();
export const defaultLimits = limitsSchema.parse({ windowMs: 3600000, services: 9, metricSamples: 5000, traceSpans: 500, logRecords: 100, evidenceRecords: 128, evidenceBytes: 131072, responseBytes: 1048576, backendTimeoutMs: 1500, durationMs: 10000, concurrent: 2, cacheEntries: 32, cacheTtlMs: 15000, staleMs: 300000, skewMs: 5000, requestsPerMinute: 20 });
export type Limits = z.infer<typeof limitsSchema>;
