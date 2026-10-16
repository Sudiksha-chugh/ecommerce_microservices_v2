import { z } from 'zod';
import { backendEndpoint, boundedJson, SourceError, finiteSample } from './transport.js';
import { evidence, digest, serviceSchema, type Service, type Investigation, type Collection, type Evidence, type Limits, type Signal, type Source } from './schemas.js';
export interface Collector {
    readonly source: Source;
    collect(request: Investigation, signal: AbortSignal): Promise<Collection>;
}
export const descriptions: Record<Signal, string> = { http_errors: 'HTTP server error ratio', http_latency: 'HTTP request latency percentile in seconds', throughput: 'HTTP requests per second', database_latency: 'Database latency percentile in seconds', retries: 'Message retries per second', business_failures: 'Business failure observations per second', span_error: 'Trace span error status indicator', span_slow: 'Trace span duration in seconds', dependency_failure: 'Downstream trace span error status indicator', queue_backlog: 'Approved snapshot reports queue backlog', service_unavailable: 'Approved snapshot reports service unavailability' };
// Metric names match existing instruments and Grafana provisioned expressions. No queue or service-up metric exists.
export const metricTemplates = [
    { signal: 'http_errors', expr: 'sum by (service_name) (rate(http_server_errors_total{FILTER}[1m])) / sum by (service_name) (rate(http_server_requests_total{FILTER}[1m]))' },
    { signal: 'http_latency', expr: 'histogram_quantile(0.95,sum by (le,service_name) (rate(http_server_request_duration_seconds_bucket{FILTER}[1m])))' },
    { signal: 'throughput', expr: 'sum by (service_name) (rate(http_server_requests_total{FILTER}[1m]))' },
    { signal: 'database_latency', expr: 'histogram_quantile(0.95,sum by (le,service_name) (rate(dependency_operation_duration_seconds_bucket{FILTER,db_system_name="postgresql"}[1m])))' },
    { signal: 'retries', expr: 'sum by (service_name) (rate(messaging_operations_total{FILTER,operation="retry"}[1m]))' },
    { signal: 'business_failures', expr: 'sum by (service_name) (rate(business_observations_total{FILTER,outcome="error"}[1m]))' }
] as const;
const prometheus = z.object({ status: z.literal('success'), data: z.object({ resultType: z.literal('matrix'), result: z.array(z.object({ metric: z.record(z.string().max(100), z.string().max(256)), values: z.array(finiteSample).max(10000) })).max(100) }), warnings: z.array(z.string().max(1000)).max(16).optional() });
export function parseMetrics(raw: unknown, request: Investigation, signal: Signal, remaining: number): {
    evidence: Evidence[];
    samples: number;
    incomplete: boolean;
} {
    const parsed = prometheus.parse(raw), start = Date.parse(request.startTime) / 1000, end = Date.parse(request.endTime) / 1000, width = end - start;
    let samples = 0, incomplete = Boolean(parsed.warnings?.length);
    const out: Evidence[] = [];
    const seen = new Set<Service>();
    for (const series of parsed.data.result) {
        samples += series.values.length;
        if (samples > remaining)
            throw new SourceError('oversized');
        const service = serviceSchema.safeParse(series.metric.service_name);
        if (!service.success || !request.services.includes(service.data)) {
            incomplete = true;
            continue;
        }
        if (seen.has(service.data))
            throw new SourceError('invalid_response');
        seen.add(service.data);
        const current: {
            time: number;
            value: number;
        }[] = [], previous: number[] = [];
        for (const [time, rawValue] of series.values) {
            const value = Number(rawValue);
            if (!Number.isFinite(value) || value < 0 || value > 1e15) {
                incomplete = true;
                continue;
            }
            if (time >= start && time <= end)
                current.push({ time, value });
            else if (time >= start - width && time < start)
                previous.push(value);
            else
                incomplete = true;
        }
        if (!current.length) {
            incomplete = true;
            continue;
        }
        current.sort((a, b) => a.time - b.time || a.value - b.value);
        const max = Math.max(...current.map(v => v.value));
        const peak = current.find(v => v.value === max)!;
        // A previous-window average is descriptive and does not prove a healthy baseline.
        const baseline = previous.length ? previous.reduce((s, v) => s + v, 0) / previous.length : undefined;
        out.push(evidence({ source: 'metrics', service: service.data, startTime: new Date(peak.time * 1000).toISOString(), endTime: new Date(peak.time * 1000).toISOString(), signal, value: max, ...(baseline !== undefined ? { baseline } : {}), observation: descriptions[signal], reference: 'prometheus:' + signal, quality: 'measured' }));
    }
    return { evidence: out, samples, incomplete: incomplete || seen.size < request.services.length };
}
export class PrometheusCollector implements Collector {
    readonly source = 'metrics';
    private endpoint: string | undefined;
    constructor(endpoint: string | undefined, private limits: Limits, private request: typeof fetch = fetch) { this.endpoint = endpoint === undefined ? undefined : backendEndpoint(endpoint); }
    async collect(input: Investigation, signal: AbortSignal): Promise<Collection> {
        const collectedAt = new Date().toISOString();
        if (!this.endpoint)
            return { source: this.source, status: 'unavailable', reason: 'disabled', collectedAt, evidence: [] };
        const all: Evidence[] = [];
        let used = 0, partial = false;
        let failure: Collection['reason'] = 'ok';
        // Sequential fixed queries keep aggregate sample accounting exact; Tempo runs concurrently.
        for (const template of metricTemplates) {
            try {
                signal.throwIfAborted();
                const start = Date.parse(input.startTime) / 1000, end = Date.parse(input.endTime) / 1000;
                const u = new URL('/api/v1/query_range', this.endpoint);
                u.searchParams.set('query', template.expr.replaceAll('FILTER', 'service_name=~"' + [...input.services].sort().join('|') + '"'));
                u.searchParams.set('start', String(Math.max(0, start - (end - start))));
                u.searchParams.set('end', String(end));
                u.searchParams.set('step', String(Math.max(15, Math.ceil(2 * (end - start) * input.services.length * metricTemplates.length / this.limits.metricSamples))));
                u.searchParams.set('timeout', this.limits.backendTimeoutMs + 'ms');
                const result = parseMetrics(await boundedJson(u.href, this.limits, signal, this.request), input, template.signal, this.limits.metricSamples - used);
                used += result.samples;
                all.push(...result.evidence);
                partial ||= result.incomplete;
            }
            catch (error) {
                partial = true;
                failure = error instanceof SourceError ? error.code : signal.aborted ? 'timeout' : 'invalid_response';
                if (failure === 'oversized' || signal.aborted)
                    break;
            }
        }
        return { source: this.source, status: !all.length ? 'unavailable' : partial ? 'partial' : 'available', reason: failure !== 'ok' ? failure : !all.length ? 'empty' : partial ? 'missing_series' : 'ok', collectedAt, evidence: all };
    }
}
const attr = z.object({ key: z.string().max(256), value: z.object({ stringValue: z.string().max(8192).optional() }).passthrough() });
const span = z.object({ traceId: z.string().max(64), spanId: z.string().max(32), parentSpanId: z.string().max(32).optional(), startTimeUnixNano: z.string().regex(/^\d{1,20}$/), endTimeUnixNano: z.string().regex(/^\d{1,20}$/), status: z.object({ code: z.union([z.number().int().min(0).max(2), z.enum(['STATUS_CODE_UNSET', 'STATUS_CODE_OK', 'STATUS_CODE_ERROR'])]).optional() }).passthrough().optional() }).passthrough();
const batch = z.object({ resource: z.object({ attributes: z.array(attr).max(128) }), scopeSpans: z.array(z.object({ spans: z.array(span).max(1000) })).max(128) });
// Tempo 2.x JSON uses batches; resourceSpans is accepted for OTLP-compatible fixtures.
export const tempo = z.union([z.object({ batches: z.array(batch).max(128) }), z.object({ resourceSpans: z.array(batch).max(128) })]);
export function hexId(value: string, bytes: number): string | undefined { if (new RegExp('^[a-f0-9]{' + bytes * 2 + '}$').test(value) && !/^0+$/.test(value))
    return value; const b = Buffer.from(value, 'base64'); return b.length === bytes && b.toString('base64') === value && !b.every(n => n === 0) ? b.toString('hex') : undefined; }
export function parseTempo(raw: unknown, input: Investigation, limits: Limits): {
    evidence: Evidence[];
    partial: boolean;
} {
    const parsed = tempo.parse(raw), batches = 'batches' in parsed ? parsed.batches : parsed.resourceSpans;
    const rows: {
        service: Service;
        id: string;
        parent: string | undefined;
        start: number;
        end: number;
        error: boolean;
        healthy: boolean;
    }[] = [];
    let count = 0, partial = false;
    for (const b of batches) {
        const s = serviceSchema.safeParse(b.resource.attributes.find(a => a.key === 'service.name')?.value.stringValue);
        for (const group of b.scopeSpans)
            for (const sp of group.spans) {
                if (++count > limits.traceSpans) {
                    partial = true;
                    continue;
                }
                if (!s.success || !input.services.includes(s.data)) {
                    partial = true;
                    continue;
                }
                const trace = hexId(sp.traceId, 16), id = hexId(sp.spanId, 8), parent = sp.parentSpanId ? hexId(sp.parentSpanId, 8) : undefined;
                const start = Number(BigInt(sp.startTimeUnixNano) / 1000000n), end = Number(BigInt(sp.endTimeUnixNano) / 1000000n);
                if (trace !== input.traceId || !id || !Number.isFinite(start) || end < start || start < Date.parse(input.startTime) - limits.skewMs || end > Date.parse(input.endTime) + limits.skewMs) {
                    partial = true;
                    continue;
                }
                rows.push({ service: s.data, id, parent, start, end, error: sp.status?.code === 2 || sp.status?.code === 'STATUS_CODE_ERROR', healthy: sp.status?.code === 1 || sp.status?.code === 'STATUS_CODE_OK' });
            }
    }
    const ids = new Set<string>();
    for (const row of rows) {
        if (ids.has(row.id))
            throw new SourceError('invalid_response');
        ids.add(row.id);
    }
    const out: Evidence[] = [];
    for (const row of rows) {
        const parent = rows.find(p => p.id === row.parent), related = parent && parent.service !== row.service ? parent.service : undefined;
        const duration = (row.end - row.start) / 1000;
        // Retain normal spans as counterevidence; span_slow is an observation signal, thresholding belongs to analysis.
        const signal: Signal = related ? 'dependency_failure' : 'span_error';
        if (row.error || row.healthy) out.push(evidence({ source: 'traces', service: row.service, startTime: new Date(row.start).toISOString(), endTime: new Date(row.end).toISOString(), signal, value: row.error ? 1 : 0, observation: descriptions[signal], reference: 'tempo:' + input.traceId! + ':' + row.id, traceId: input.traceId!, spanId: row.id, ...(row.parent ? { parentSpanId: row.parent } : {}), ...(related ? { relatedService: related } : {}), quality: 'measured' }));
        out.push(evidence({ source: 'traces', service: row.service, startTime: new Date(row.start).toISOString(), endTime: new Date(row.end).toISOString(), signal: 'span_slow', value: duration, observation: descriptions.span_slow, reference: 'tempo:' + input.traceId! + ':' + row.id, traceId: input.traceId!, spanId: row.id, ...(row.parent ? {parentSpanId:row.parent} : {}), ...(related ? {relatedService:related} : {}), quality:'measured' }));
    }
    return { evidence: out.slice(0, limits.evidenceRecords), partial: partial || out.length === 0 || out.length > limits.evidenceRecords };
}
export class TempoCollector implements Collector {
    readonly source = 'traces';
    private endpoint: string | undefined;
    constructor(endpoint: string | undefined, private limits: Limits, private request: typeof fetch = fetch) { this.endpoint = endpoint === undefined ? undefined : backendEndpoint(endpoint); }
    async collect(input: Investigation, signal: AbortSignal): Promise<Collection> {
        const collectedAt = new Date().toISOString();
        if (!this.endpoint || !input.traceId)
            return { source: this.source, status: 'unavailable', reason: !this.endpoint ? 'disabled' : 'trace_id_required', collectedAt, evidence: [] };
        try {
            const u = new URL('/api/traces/' + input.traceId, this.endpoint);
            u.searchParams.set('start', String(Math.floor(Date.parse(input.startTime) / 1000)));
            u.searchParams.set('end', String(Math.ceil(Date.parse(input.endTime) / 1000)));
            const result = parseTempo(await boundedJson(u.href, this.limits, signal, this.request), input, this.limits);
            return { source: this.source, status: result.partial ? 'partial' : 'available', reason: !result.evidence.length ? 'empty' : result.partial ? 'truncated' : 'ok', collectedAt, evidence: result.evidence };
        }
        catch (error) {
            return { source: this.source, status: 'unavailable', reason: error instanceof SourceError ? error.code : signal.aborted ? 'timeout' : 'invalid_response', collectedAt, evidence: [] };
        }
    }
}
// Operator-approved in-memory structured snapshots only. Never read arbitrary files or accept API log payloads.
const snapshot = z.array(z.object({ service: serviceSchema, timestamp: z.iso.datetime({ offset: true }), event: z.enum(['retry', 'queue_backlog', 'service_unavailable']), value: z.number().finite().min(0).max(1e15) }).strict()).max(256);
export class SnapshotLogCollector implements Collector {
    readonly source = 'logs';
    private rows: z.infer<typeof snapshot> | undefined;
    constructor(rows: unknown = undefined, private maxRecords = 100) { if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 256)
        throw new Error('Invalid snapshot bound'); this.rows = rows === undefined ? undefined : snapshot.parse(rows); }
    async collect(input: Investigation, _signal: AbortSignal): Promise<Collection> {
        const collectedAt = new Date().toISOString();
        if (!this.rows)
            return { source: this.source, status: 'unavailable', reason: 'unsupported', collectedAt, evidence: [] };
        const rows = this.rows.filter(r => input.services.includes(r.service) && Date.parse(r.timestamp) >= Date.parse(input.startTime) && Date.parse(r.timestamp) <= Date.parse(input.endTime));
        const out = rows.slice(0, this.maxRecords).map(r => { const signal: Signal = r.event === 'retry' ? 'retries' : r.event; return evidence({ source: 'logs', service: r.service, startTime: r.timestamp, endTime: r.timestamp, signal, value: r.value, observation: descriptions[signal], reference: 'snapshot:' + digest(r), quality: 'snapshot' }); });
        return { source: this.source, status: 'partial', reason: rows.length > this.maxRecords ? 'truncated' : !out.length ? 'empty' : 'ok', collectedAt, evidence: out };
    }
}
export function defaultCollectors(endpoints: {
    prometheus?: string;
    tempo?: string;
}, limits: Limits): Collector[] { return [new PrometheusCollector(endpoints.prometheus, limits), new TempoCollector(endpoints.tempo, limits), new SnapshotLogCollector(undefined, limits.logRecords)]; }
