import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { initializeTelemetry } from '../../bootstrap.mjs';
it('exports bounded incident metrics and spans without evidence identifiers or raw data', async () => {
    const spans = new InMemorySpanExporter(), exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const state = await initializeTelemetry({ OTEL_ENABLED: 'true', OTEL_SERVICE_NAME: 'incident-test', OTEL_TRACES_SAMPLER_ARG: '1' }, { spanExporter: spans, metricReader: new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 10000 }) });
    try {
        const { IncidentAnalysis } = await import('../../src/incident/engine.js');
        const { IncidentAi, incidentAiConfig } = await import('../../src/incident/ai.js');
        const { fakeCollectors, request, limits, now, collected } = await import('./fixtures.js');
        const ai = new IncidentAi({ ...incidentAiConfig({}), enabled: true }, { identity: 'fake:v1', enrich: async () => { throw new Error('private-secret'); } });
        const collectors = fakeCollectors();
        collectors[1]!.collect = async () => collected('traces', [], { reason: 'timeout' });
        await new IncidentAnalysis(collectors, limits, ai, () => now).analyze(request);
        await state.flush();
        const data = exporter.getMetrics().flatMap(m => m.scopeMetrics.flatMap(s => s.metrics)).filter(m => m.descriptor.name.startsWith('incident_analysis_'));
        expect(data.map(m => m.descriptor.name)).toEqual(expect.arrayContaining(['incident_analysis_requests_total', 'incident_analysis_duration_seconds', 'incident_analysis_source_failures_total', 'incident_analysis_partial_reports_total', 'incident_analysis_ai_failures_total', 'incident_analysis_inflight_requests']));
        for (const metric of data)
            for (const point of metric.dataPoints)
                expect(Object.keys(point.attributes).every(k => k === 'source')).toBe(true);
        const spanData = spans.getFinishedSpans().map(s => ({ name: s.name, attributes: s.attributes, events: s.events }));
        expect(spanData.map(s => s.name)).toEqual(expect.arrayContaining(['incident.collect', 'incident.correlate', 'incident.analyze', 'incident.ai_enrich']));
        const serialized = JSON.stringify({ data, spans: spanData });
        for (const forbidden of [request.incidentId, request.traceId, 'private-secret', 'prometheus:http_errors'])
            expect(serialized).not.toContain(forbidden);
    }
    finally {
        await state.shutdown();
    }
});
it('the incident runtime has no mutation, shell or message publishing capabilities', async () => { for (const file of ['schemas', 'transport', 'collectors', 'analysis', 'ai', 'engine', 'api', 'server']) {
    const source = await readFile(new URL('../../src/incident/' + file + '.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"](?:pg|node:child_process|amqplib)|\b(?:execFile|spawn|publish|sendToQueue)\(/);
} });
