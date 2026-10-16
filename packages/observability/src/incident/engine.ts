import { operation } from '../context.js';
import { IncidentAi, incidentAiConfig } from './ai.js';
import { correlate, incidentSummary } from './analysis.js';
import type { Collector } from './collectors.js';
import { incidentMetric } from './telemetry.js';
import { collectionSchema, requestSchema, reportSchema, limitsSchema, defaultLimits, digest, type Limits, type Investigation, type Collection, type Report, type Evidence, type Source } from './schemas.js';
export class InvalidInvestigation extends Error { constructor() { super('invalid_investigation'); } }
export class InvestigationBusy extends Error {
    constructor() { super('busy'); }
}
export class IncidentAnalysis {
    private cache = new Map<string, {
        expires: number;
        requestKey: string;
        value: Report;
    }>();
    private pending = new Map<string, Promise<Report>>();
    private collecting = 0;
    readonly limits: Limits;
    private ai: IncidentAi;
    constructor(private collectors: Collector[], limits: Limits = defaultLimits, ai?: IncidentAi, private now = Date.now) { this.limits = Object.freeze(limitsSchema.parse(limits)); this.ai = ai ?? new IncidentAi(incidentAiConfig({})); if (collectors.length !== 3 || new Set(collectors.map(c => c.source)).size !== 3)
        throw new Error('Exactly three distinct evidence sources required'); }
    health() { return { status: 'ready', ai: this.ai.identity(), inflight: this.pending.size }; }
    capabilities() { return { services: ['api-gateway', 'auth-service', 'catalog-service', 'cart-service', 'orders-service', 'payments-service', 'inventory-service', 'notification-service', 'search-service'], sources: { metrics: 'fixed_promql', traces: 'trace_id_lookup_only', logs: 'approved_snapshots_only' }, limits: this.limits, remediation: false, ai: this.ai.identity() }; }
    async analyze(raw: unknown): Promise<Report> {
        const parsed = requestSchema.parse(raw);
        const input: Investigation = { ...parsed, services: [...parsed.services].sort(), startTime: new Date(parsed.startTime).toISOString(), endTime: new Date(parsed.endTime).toISOString() };
        const now = this.now();
        if (input.services.length > this.limits.services || Date.parse(input.endTime) - Date.parse(input.startTime) > this.limits.windowMs || Date.parse(input.endTime) > now + this.limits.skewMs)
            throw new InvalidInvestigation();
        const key = digest([1, 'collector-v1', this.ai.identity(), input]);
        for (const [k, v] of this.cache)
            if (v.expires <= now)
                this.cache.delete(k);
        incidentMetric('request');
        const cached = [...this.cache.values()].find(entry => entry.requestKey === key);
        if (cached) {
            const r = structuredClone(cached.value);
            r.freshness.cache = 'hit';
            r.freshness.stale = this.stale(r);
            return reportSchema.parse(r);
        }
        const pending = this.pending.get(key);
        if (pending) {
            const r = structuredClone(await pending);
            r.freshness.cache = 'deduplicated';
            r.freshness.stale = this.stale(r);
            return reportSchema.parse(r);
        }
        if (this.pending.size >= this.limits.concurrent || this.collecting + 2 > this.limits.concurrent * 2)
            throw new InvestigationBusy();
        const job = this.run(input);
        this.pending.set(key, job);
        try {
            const result = await job;
            if (this.limits.cacheEntries && this.limits.cacheTtlMs && result.observations.length && !result.sourceStatuses.some(s => ['timeout', 'unavailable', 'invalid_response', 'oversized', 'truncated'].includes(s.reason))) {
                if (this.cache.size >= this.limits.cacheEntries)
                    this.cache.delete(this.cache.keys().next().value!);
                const expires = this.now() + this.limits.cacheTtlMs;
                result.freshness.cacheExpiresAt = new Date(expires).toISOString();
                this.cache.set(key + ':' + result.freshness.snapshotVersion, { expires, requestKey: key, value: structuredClone(result) });
            }
            return structuredClone(result);
        }
        finally {
            this.pending.delete(key);
        }
    }
    private stale(r: Report) { return !r.freshness.latestEvidenceAt || this.now() - Date.parse(r.freshness.latestEvidenceAt) > this.limits.staleMs; }
    private async collect(source: Source, input: Investigation, signal: AbortSignal): Promise<Collection> {
        const fallback = (reason: Collection['reason']): Collection => ({ source, status: 'unavailable', reason, collectedAt: new Date(this.now()).toISOString(), evidence: [] });
        if (signal.aborted)
            return fallback('timeout');
        const collector = this.collectors.find(c => c.source === source)!;
        this.collecting++;
        let abort: (() => void) | undefined;
        try {
            const result = await operation('incident.collect', { source }, () => Promise.race([Promise.resolve().then(() => { return collector.collect(structuredClone(input), signal); }).finally(() => this.collecting--), new Promise<never>((_, reject) => { abort = () => reject(new Error('deadline')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted)
                    abort(); })]));
            const safe = collectionSchema.parse(result);
            if (safe.source !== source || safe.evidence.some(e => e.source !== source))
                return fallback('invalid_response');
            if (safe.status === 'available' && !safe.evidence.length)
                return fallback('empty');
            return safe;
        }
        catch {
            return fallback(signal.aborted ? 'timeout' : 'invalid_response');
        }
        finally {
            if (abort)
                signal.removeEventListener('abort', abort);
        }
    }
    private async run(input: Investigation): Promise<Report> {
        const started = performance.now();
        incidentMetric('inflight', 1);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.limits.durationMs);
        try {
            return await operation('incident.analyze', {}, async () => {
                // At most two backend collections run concurrently; logs are a bounded local snapshot pass.
                const collected = await Promise.all([this.collect('metrics', input, controller.signal), this.collect('traces', input, controller.signal)]);
                collected.push(await this.collect('logs', input, controller.signal));
                const records: Evidence[] = [];
                const ids = new Set<string>();
                let bytes = 2, truncated = false, excluded = false;
                for (const source of collected)
                    for (const e of [...source.evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))) {
                        if (!input.services.includes(e.service) || (e.relatedService && !input.services.includes(e.relatedService)) || Date.parse(e.endTime) < Date.parse(e.startTime) || Date.parse(e.startTime) < Date.parse(input.startTime) - this.limits.skewMs || Date.parse(e.endTime) > Date.parse(input.endTime) + this.limits.skewMs) {
                            excluded = true;
                            source.status = 'partial';
                            source.reason = 'outside_window';
                            continue;
                        }
                        if (ids.has(e.evidenceId))
                            continue;
                        const n = Buffer.byteLength(JSON.stringify(e)) + 1;
                        if (records.length >= this.limits.evidenceRecords || bytes + n > this.limits.evidenceBytes) {
                            truncated = true;
                            source.status = 'partial';
                            source.reason = 'truncated';
                            continue;
                        }
                        bytes += n;
                        ids.add(e.evidenceId);
                        records.push(e);
                    }
                const analysis = await operation('incident.correlate', {}, async () => correlate(input, records, this.limits.skewMs));
                const findings = analysis.findings.slice(0, 64);
                if (findings.length < analysis.findings.length)
                    truncated = true;
                const limitations = ['Correlation and temporal order do not establish causality', 'Traces are sampled and one trace cannot establish incident wide coverage', 'Service availability and queue depth metrics are not exported by the current stack', 'No automatic root cause verification or remediation is performed'];
                for (const source of collected) {
                    if (source.status !== 'available') {
                        limitations.push(source.source + ' coverage is ' + source.status + ' due to ' + source.reason);
                        if (!['unsupported', 'disabled', 'trace_id_required', 'empty', 'missing_series'].includes(source.reason))
                            incidentMetric('source_failure', 1, { source: source.source });
                    }
                }
                if (truncated)
                    limitations.push('Evidence or findings were truncated by configured resource bounds');
                if (excluded)
                    limitations.push('Out of scope evidence was excluded');
                const partial = truncated || excluded || collected.some(c => c.status !== 'available');
                const latest = records.length ? new Date(Math.max(...records.map(e => Date.parse(e.endTime)))).toISOString() : null;
                let report: Report = reportSchema.parse({ schemaVersion: 1, incidentId: input.incidentId, status: partial ? 'partial' : 'analyzed', summary: incidentSummary(findings), severity: findings.some(f => f.severity === 'high') ? 'high' : findings.length ? 'medium' : 'low', affectedServices: [...new Set(findings.flatMap(f => f.affectedServices))].sort(), timeWindow: { start: input.startTime, end: input.endTime }, analysisTimestamp: new Date(this.now()).toISOString(), analysisMode: 'deterministic', aiStatus: 'disabled', observations: analysis.observations, findings, rootCauseHypotheses: analysis.hypotheses, recommendedActions: findings.length ? ['Review ranked hypotheses and their supporting and contradicting evidence', 'Inspect representative failed traces and dependency diagnostics'] : ['Collect representative metrics and traces for the investigation interval'], dependencies: analysis.dependencies, coverage: Object.fromEntries(collected.map(c => [c.source, c.status])), sourceStatuses: collected.map(({ evidence: _evidence, ...status }) => status), freshness: { snapshotVersion: digest(analysis.observations), collectedAt: new Date(this.now()).toISOString(), latestEvidenceAt: latest, stale: !latest || this.now() - Date.parse(latest) > this.limits.staleMs, cache: 'miss', cacheExpiresAt: null }, limitations });
                report = await this.ai.enrich(report, controller.signal);
                if (report.aiStatus !== 'disabled' && report.aiStatus !== 'success')
                    incidentMetric('ai_failure', 1);
                if (partial)
                    incidentMetric('partial');
                report = reportSchema.parse(report);
                if (Buffer.byteLength(JSON.stringify(report)) > 1048576)
                    throw new Error('Report exceeds payload bound');
                return report;
            });
        }
        finally {
            clearTimeout(timer);
            controller.abort();
            incidentMetric('inflight', -1);
            incidentMetric('duration', (performance.now() - started) / 1000);
        }
    }
}
