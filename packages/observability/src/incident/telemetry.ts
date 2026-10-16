import { metrics } from '@opentelemetry/api';
const meter = metrics.getMeter('ecommerce.incident-analysis', '1');
const requests = meter.createCounter('incident_analysis_requests_total'), duration = meter.createHistogram('incident_analysis_duration_seconds', { unit: 's' }), failures = meter.createCounter('incident_analysis_source_failures_total'), partial = meter.createCounter('incident_analysis_partial_reports_total'), ai = meter.createCounter('incident_analysis_ai_failures_total'), inflight = meter.createUpDownCounter('incident_analysis_inflight_requests');
export function incidentMetric(event: 'request' | 'duration' | 'source_failure' | 'partial' | 'ai_failure' | 'inflight', value = 1, attributes: Record<string, string> = {}) { try {
    if (event === 'duration')
        duration.record(value, attributes);
    else
        ({ request: requests, source_failure: failures, partial, ai_failure: ai, inflight })[event].add(value, attributes);
}
catch { /* Failure isolated diagnostic telemetry. */ } }
