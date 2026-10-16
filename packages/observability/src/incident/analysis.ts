import { digest, findingSchema, hypothesisSchema, type Evidence, type Finding, type Hypothesis, type Edge, type Service, type Investigation } from './schemas.js';
// Declared application dependencies, verified against gateway, orders/cart/inventory clients and saga consumers.
const declared: readonly (readonly [
    Service,
    Service
])[] = [['api-gateway', 'auth-service'], ['api-gateway', 'catalog-service'], ['api-gateway', 'cart-service'], ['api-gateway', 'orders-service'], ['api-gateway', 'payments-service'], ['api-gateway', 'inventory-service'], ['api-gateway', 'search-service'], ['orders-service', 'cart-service'], ['orders-service', 'catalog-service'], ['orders-service', 'payments-service'], ['orders-service', 'inventory-service'], ['cart-service', 'catalog-service'], ['inventory-service', 'catalog-service']];
export function anomalous(e: Evidence): boolean { switch (e.signal) {
    case 'http_errors': return e.value >= 0.05;
    case 'http_latency':
    case 'span_slow': return e.value >= 1;
    case 'database_latency': return e.value >= 0.1 && (e.baseline === undefined || e.value >= e.baseline * 2);
    case 'retries':
    case 'business_failures':
    case 'span_error':
    case 'dependency_failure':
    case 'queue_backlog':
    case 'service_unavailable': return e.value > 0;
    case 'throughput': return false;
} }
const explanations:Record<Evidence['signal'],string>={
 http_errors:'HTTP server error ratio crosses the five percent review threshold',
 http_latency:'HTTP request latency crosses the one second review threshold',
 throughput:'HTTP throughput is retained as descriptive context',
 database_latency:'Database latency crosses the review threshold and available baseline comparison',
 retries:'Positive retry observations may indicate repeated work and require workload context',
 business_failures:'Business error observations are present without establishing a particular workflow state',
 span_error:'A collected trace span reports an error status',
 span_slow:'Observed span duration crosses the one second review threshold',
 dependency_failure:'A downstream span with an observed parent relationship reports an error status',
 queue_backlog:'An approved snapshot reports queued work without establishing its initial trigger',
 service_unavailable:'An approved snapshot reports service unavailability requiring independent validation'
};
export function incidentSummary(findings:Finding[]):string {
 if(!findings.length)return 'Available evidence does not establish degradation';
 const components=[...new Set(findings.flatMap(f=>f.affectedServices))].sort();
 const symptoms=[...new Set(findings.filter(f=>f.category!=='multi_service_degradation').map(f=>f.category.replaceAll('_',' ')))].sort().slice(0,4);
 return 'Observed '+symptoms.join(', ')+' affecting '+components.join(', ')+'. Validate the linked evidence before attributing a cause';
}
export function correlate(input: Investigation, records: Evidence[], skewMs: number) {
    const observations = [...records].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.service.localeCompare(b.service) || a.evidenceId.localeCompare(b.evidenceId));
    const edges: Edge[] = declared.filter(([a, b]) => input.services.includes(a) && input.services.includes(b)).map(([from, to]) => ({ from, to, kind: 'static', evidenceIds: [] }));
    const observed = new Map<string, Edge>();
    for (const e of observations) {
        if (!e.relatedService || !e.traceId || !e.parentSpanId)
            continue;
        const parents = observations.filter(p => p.traceId === e.traceId && p.spanId === e.parentSpanId && p.service === e.relatedService);
        if (!parents.length)
            continue;
        const key = e.relatedService + ':' + e.service;
        const edge = observed.get(key) ?? { from: e.relatedService, to: e.service, kind: 'observed' as const, evidenceIds: [] };
        edge.evidenceIds = [...new Set([...edge.evidenceIds, ...parents.map(p => p.evidenceId), e.evidenceId])].sort();
        observed.set(key, edge);
    }
    edges.push(...observed.values());
    edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
    const findings: Finding[] = [];
    for (const service of [...input.services].sort())
        for (const signal of [...new Set(observations.filter(e => e.service === service && anomalous(e)).map(e => e.signal))].sort()) {
            const items = observations.filter(e => e.service === service && e.signal === signal && anomalous(e));
            const evidenceIds = items.map(e => e.evidenceId).sort();
            findings.push(findingSchema.parse({ findingId: 'f_' + digest([signal, service, evidenceIds]), category: signal, severity: ['span_error', 'dependency_failure', 'service_unavailable'].includes(signal) ? 'high' : 'medium', confidence: items.some(e => e.quality === 'snapshot') ? 'low' : 'medium', affectedServices: [service], evidenceIds, explanation: explanations[signal], limitations: ['Thresholds identify symptoms and do not establish a cause', 'A previous window is descriptive and is not a validated healthy baseline'], classification: 'observed_symptom' }));
        }
    // Require linked services, anomalies on both sides, and overlapping evidence (including bounded clock skew).
    const involved = new Set<Service>(), linked = new Set<string>();
    for (const edge of edges) {
        const a = observations.filter(e => e.service === edge.from && anomalous(e)), b = observations.filter(e => e.service === edge.to && anomalous(e));
        for (const x of a)
            for (const y of b) {
                if (Date.parse(x.startTime) <= Date.parse(y.endTime) + skewMs && Date.parse(y.startTime) <= Date.parse(x.endTime) + skewMs) {
                    involved.add(edge.from);
                    involved.add(edge.to);
                    linked.add(x.evidenceId);
                    linked.add(y.evidenceId);
                }
            }
    }
    if (involved.size > 1) {
        const evidenceIds = [...linked].sort();
        findings.push(findingSchema.parse({ findingId: 'f_' + digest(['multi', evidenceIds]), category: 'multi_service_degradation', severity: 'high', confidence: observed.size ? 'medium' : 'low', affectedServices: [...involved].sort(), evidenceIds, explanation: 'Linked services have temporally overlapping degradation observations', limitations: ['Temporal correlation does not prove causality', 'Static relationships describe possible dependencies rather than observed calls'], classification: 'observed_symptom' }));
    }
    findings.sort((a, b) => a.category.localeCompare(b.category) || a.findingId.localeCompare(b.findingId));
    const hypotheses = rankHypotheses(observations, edges, skewMs);
    return { observations, dependencies: edges, findings, hypotheses };
}
export function rankHypotheses(observations: Evidence[], edges: Edge[], skewMs: number): Hypothesis[] {
    const candidates: {
        h: Hypothesis;
        score: number;
        onset: number;
    }[] = [];
    for (const service of [...new Set(observations.map(e => e.service))].sort()) {
        const own = observations.filter(e => e.service === service), support = own.filter(anomalous);
        if (!support.length)
            continue;
        // Healthy samples only contradict matching anomalous signals, never unrelated throughput.
        const signals = new Set(support.map(e => e.signal));
        const contrary = own.filter(e => !anomalous(e) && signals.has(e.signal));
        const sources = new Set(support.map(e => e.source));
        const onset = Math.min(...support.map(e => Date.parse(e.startTime)));
        const downstream = edges.filter(edge => edge.to === service && observations.some(e => e.service === edge.from && anomalous(e) && Date.parse(e.startTime) + skewMs >= onset));
        const runtime = downstream.some(e => e.kind === 'observed');
        const types = new Set(support.map(e => e.signal));
        const reason = types.has('database_latency') ? 'Database latency may contribute to the observed service degradation' : types.has('queue_backlog') ? 'Queue backlog may contribute to delayed work' : types.has('retries') ? 'Repeated retries may amplify the observed degradation' : types.has('service_unavailable') ? 'Service unavailability may contribute to dependent failures' : runtime ? 'Observed downstream degradation may contribute to dependent symptoms' : 'Service degradation is a candidate contributing factor';
        const confidence = sources.size >= 2 && runtime && !contrary.length ? 'medium' : 'low';
        candidates.push({ h: hypothesisSchema.parse({ hypothesisId: 'h_' + digest([service, support.map(e => e.evidenceId).sort()]), candidateComponent: service, classification: 'root_cause_hypothesis', supportingEvidenceIds: support.map(e => e.evidenceId).sort(), contradictingEvidenceIds: contrary.map(e => e.evidenceId).sort(), confidence, reasoningSummary: reason, missingEvidence: ['No explicit root cause verification has been performed', 'Representative external dependency and resource utilization evidence is unavailable'], validationSteps: ['Inspect representative failed traces and service diagnostics', 'Compare observed latency with a representative healthy workload', 'Check dependency timing and contrary observations before deciding on a cause'] }), score: sources.size * 4 + Math.min(signals.size, 4) + (runtime ? 3 : downstream.length ? 1 : 0) - contrary.length * 2, onset });
    }
    return candidates.sort((a, b) => b.score - a.score || a.onset - b.onset || a.h.candidateComponent.localeCompare(b.h.candidateComponent)).map(c => c.h);
}
