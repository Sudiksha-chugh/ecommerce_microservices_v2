# Phase 20: evidence-grounded incident analysis

## Architecture and scope

Phase 20 is an opt-in read-only diagnostic capability in `@ecommerce/observability/incident`. It reuses the Phase 17 Collector, Prometheus, Tempo, OpenTelemetry API and existing JWT verifier. It adds no application microservice, database, logging platform, queue, frontend, migration or business-path dependency.

An authenticated request passes through strict validation, a bounded collection plan, concurrent metrics/trace collection, optional approved log snapshots, normalization and allowlisting, deterministic correlation, findings, ranked hypotheses, a deterministic report, optional advisory enrichment and final runtime validation. An engineer reviews every proposed investigation. There is no remediation executor.

The incident router can share the existing Phase 19 loopback SQL diagnostics listener when `INCIDENT_DIAGNOSTICS_ENABLED=true`. A separate CLI entry point starts the same diagnostic capability without requiring a SQL diagnostic database pool. Business servers and the public gateway do not mount this router.

## Repository evidence source map

The baseline was `c3c75ba`, containing Phase 19 and matching fetched `origin/main` before implementation.

- `packages/observability/src/metrics.ts` defines HTTP duration/count/errors, dependency duration, message operations, business observations and search rebuild duration.
- `packages/observability/src/dependencies.ts` records PostgreSQL operations with `db.system.name=postgresql`.
- `infrastructure/observability/collector.yaml` exports traces to Tempo and metrics to the existing Prometheus exporter on 8889. Resource attributes become metric labels, including `service_name`.
- `infrastructure/observability/prometheus.yaml` scrapes the Collector every five seconds. It does not scrape per-service readiness or RabbitMQ queue depth.
- `compose.observability.yaml` pins Prometheus v3.13.4, Tempo 2.10.8, Collector 0.162.0 and Grafana 13.1.6. Their published endpoints bind to host loopback. Application containers cannot reach them through their own loopback.
- `infrastructure/observability/tempo.yaml` uses local trace storage with one-hour retention. This implementation uses trace-ID lookup only; it neither assumes nor exposes TraceQL/search capability.
- `packages/observability/src/middleware.ts` emits bounded structured HTTP completion logs to stdout. There is no configured log query pipeline. Elasticsearch is a product-search projection, not an application log backend.

## Collectors and normalization

Prometheus uses six fixed `query_range` templates: HTTP server error ratio, HTTP p95 latency, HTTP throughput, PostgreSQL dependency p95 latency, message retry rate and business error observations. Their metric names match existing instruments and dashboard expressions. Callers cannot submit expressions. Queries group by allowlisted service identity and use a resolution of at least 15 seconds, adjusted to the sample budget. They request the investigation interval and an equally long preceding interval, with a one-minute rate lookback.

Each current series becomes a peak observation with its actual sample timestamp. Previous-window samples provide a descriptive mean when available. This is not an onset estimate or a validated healthy baseline. Missing series, nonfinite values, warnings and service coverage gaps remain explicit. Generic business error observations do not establish a particular saga state or payment-provider fault.

Tempo uses `GET /api/traces/{traceId}?start=...&end=...` with JSON content negotiation, following the [Tempo HTTP API](https://grafana.com/docs/tempo/latest/api_docs/). The parser accepts Tempo `batches` and OTLP-compatible `resourceSpans`, numeric or named status codes, hex or canonical base64 identifiers. Only allowlisted service identities, trace/span/parent identifiers, times, duration and error status survive normalization. Raw span names, events, paths, bodies, attributes and exception messages are discarded. Every retained span contributes a duration observation. Explicit error or success status contributes an additional indicator, including zero for explicit success; unset or missing status never becomes fabricated healthy counterevidence. This preserves failed-span duration and successful-span counterevidence; normalized evidence has a separate cap from raw span count. Error spans and slow spans are observations, not verified causes.

No queryable log backend exists. The default log collector reports `unsupported`. An embedding operator can explicitly supply `SnapshotLogCollector` with bounded structured records containing only an allowlisted service, timestamp, reviewed event enum and numeric value. Accepted events are retry, queue backlog and service unavailability. These snapshots always have partial coverage and snapshot quality; arbitrary free-text messages and unknown fields are rejected. The API does not accept snapshots, filenames or log queries. There is no filesystem scraping.

Stable evidence IDs are content hashes of normalized observations. Provenance includes source type, metric template or trace/span reference or snapshot digest, timestamps, collection status, quality and sanitization status. Sensitive free text is removed before findings, caching, telemetry or provider input.

## Correlation and hypotheses

The engine sorts observations by timestamp, service and evidence ID. Findings and dependency edges also have stable tie breakers. The static graph is derived from the gateway upstreams, Orders Cart/Catalog clients, Cart and Inventory Catalog clients, and checkout saga command dependencies. Static saga relationships describe asynchronous logical dependencies, not observed synchronous calls.

Observed edges require a child and parent span from the same requested trace and selected services. Static and observed edges remain distinct. No hypothesized edge is fabricated when runtime evidence is absent.

Rules require actual evidence:

- HTTP error ratio at least five percent.
- HTTP p95 or normal span duration at least one second.
- Database p95 at least 100 ms, and at least twice the previous-window mean when present.
- Positive retry, business error, error span, dependency error, approved queue backlog or approved unavailable-service observations.
- Multi-service degradation only when both linked services have anomalies overlapping within the configured clock-skew allowance.

Throughput is descriptive context; zero throughput alone never proves a service is unavailable. Missing telemetry produces coverage limitations, not anomaly findings. Thresholds are review heuristics and are not workload SLOs. Metrics retain peak timestamps, so correlation is intentionally conservative and can miss degradation with peaks at different times. There is no complete critical-path reconstruction.

One hypothesis per degraded selected service references supporting evidence and healthy observations for the same signal as possible counterevidence. Ranking uses independent-source count, distinct anomalous signals, dependency relationships consistent with available timing, and contrary evidence. Ties use onset of the available observations and service identity. Temporal ordering alone never establishes a cause. Confidence is low or medium, never a calibrated probability; this implementation has no mechanism to verify root causes. Resource saturation and external-provider hypotheses are not invented without supporting telemetry.

Recommended steps are reviewed diagnostic prose, such as comparing representative healthy workloads and examining failed traces. Reports contain no executable commands, SQL or automatic actions.

## Optional AI

AI is disabled by default. Deterministic reports need no credentials or provider. Explicit `offline` enrichment exercises the same output-validation path with no network call. Optional `openai` requires an explicit model and key; never enable it in CI.

Phase 19's fixed-destination, bounded provider HTTP transport is extracted as `requestAdvisorJson` and reused without changing the SQL advisor wire format. Incident AI also reuses Phase 19 configuration bounds and provider error codes. Its orchestration separately accounts for incident deadlines, physical in-flight calls, a conservative input-plus-output allocation, request budget and a three-failure, 30-second circuit breaker. This separate orchestration is necessary because incident reports and SQL advisor recommendations have different schemas and cancellation lifecycles. No new provider networking implementation is introduced.

The model receives sanitized deterministic findings, hypotheses and coverage in a structured data field, separated from fixed instructions. It can choose one of two reviewed summary narratives. It cannot rewrite observations, rankings, evidence references, confidence, limitations or recommended actions. Arbitrary prose, unsupported causal claims, additional fields and tool requests fail closed to the deterministic report. Timeout, budget, outage, invalid output and circuit-open status remain visible as `aiStatus`. This intentionally limits enrichment; the AI does not freely reason into new factual claims or reorder deterministic rankings.

## Privacy and network security

Backend origins are operator configuration only and require HTTP literal IPv4 or IPv6 loopback origins without paths, query, fragment, credentials or DNS names. Remote backends need an authenticated operator-managed local tunnel. This prevents caller-directed SSRF, DNS rebinding, metadata access and redirect traversal. All backend requests are GET, use fixed paths/templates and reject redirects.

HTTP collectors enforce timeouts, streamed and declared byte limits, JSON content types and runtime response validation. Pagination and backend retries are zero. Only two backend source collections run concurrently; fixed Prometheus queries are sequential to maintain an aggregate sample budget. Physical collection/provider capacity remains occupied until an underlying call settles, even when an injected adapter ignores cancellation.

Prompt injection defenses use structural field removal, strict enum/numeric schemas, size limits, structured instruction/data separation and literal-only model output validation. They do not rely on system prompts alone. No raw responses, prompts, exception text, authorization headers, customer fields or request bodies are logged or traced.

## Diagnostics API and deployment

All routes require the existing cryptographic RS256 JWT verifier with configured issuer, audience and required claims, plus admin role authorization:

- `POST /internal/incidents/analyze`
- `GET /internal/incidents/health`
- `GET /internal/incidents/capabilities`

No retrieval endpoint or durable persistence is added. Health describes local readiness and AI identity, not proof of backend health. Source health belongs to each report. Capabilities describe implemented adapters, not guaranteed backend availability.

Example request:

```json
{"incidentId":"checkout-review","startTime":"2026-10-15T10:00:00Z","endTime":"2026-10-15T10:05:00Z","services":["api-gateway","orders-service","payments-service"],"traceId":"1234567890abcdef1234567890abcdef"}
```

Unknown fields, duplicate/unknown services, arbitrary expressions/URLs/actions, malformed timestamps and invalid trace IDs are rejected. The global API body limit is 2 KiB for the analysis endpoint. Responses use `Cache-Control: no-store`. Authentication failures return 401, non-admins 403, invalid input 400 and rate/concurrency admission failures 429. Parser errors return fixed sanitized messages; unexpected analysis failures return a sanitized 503 response.

Copy `.env.incident-analysis.example` to a local ignored file and provide existing JWT public key configuration. The scripts do not implicitly load that file:

```sh
node --env-file=.env.incident-analysis --import ./packages/observability/bootstrap.mjs --import tsx scripts/incident-diagnostics.mjs
```

Alternatively export configuration and run `npm run incident:diagnostics`. Disabled startup performs no credential reads and opens no listener. Enabled startup binds explicitly to 127.0.0.1, caps connections at eight and applies HTTP header/request/keepalive timeouts. Do not proxy this port through the public gateway or publish it on a public interface. An admin JWT alone is not the network boundary. An authenticated local tunnel is the intended remote operator access mechanism. Shared listener deployments inherit the Phase 19 listener boundary.

## Failure isolation and limits

No business server imports or awaits incident analysis. No database pool, shell capability, message publisher or provider action tool exists in the incident runtime. Source failures return partial reports; AI failures preserve deterministic results. A total source outage returns no unsupported findings. Invalid evidence is excluded with source status changes. Truncation and stale evidence remain visible.

Defaults, with validated hard ceilings in `limitsSchema`:

- Investigation window: 1 hour; at most 9 selected services.
- Investigation deadline: 10 seconds; at most 30 seconds configurable.
- Concurrent investigations: 2; hard ceiling 4. Authenticated admissions: 20 per minute, ceiling 120.
- Metric samples: 5,000 across all queries, hard ceiling 10,000.
- Trace spans: 500, hard ceiling 1,000. Approved log records: 100, hard ceiling 256.
- Evidence records: 128, hard ceiling 256; normalized evidence bytes: 128 KiB, hard ceiling 256 KiB.
- Each backend response: 1 MiB, hard ceiling 2 MiB; timeout 1,500 ms, ceiling 5 seconds.
- Final serialized report hard limit: 1 MiB; at most 64 findings and 9 hypotheses.
- Clock-skew allowance: 5 seconds, ceiling 60 seconds. Freshness threshold: 5 minutes.
- AI timeout: 3 seconds, at most 10 seconds; output allocation 2,000, at most 4,000; conservative budget 100,000 per minute; at most 2 provider calls.

Environment keys use `INCIDENT_LIMIT_` followed by the uppercase snake case of the limit name, for example `INCIDENT_LIMIT_TRACE_SPANS`. The configuration example lists every limit. Evidence byte truncation retains actual evidence references and marks partial analysis. Prometheus range/baseline collection can exhaust the overall deadline at extreme configured settings; this is reported rather than blocking indefinitely.

## Caching and freshness

Caching is bounded, in-process and non-durable: 32 entries and a 15-second TTL by default, maximum 128 entries and 60 seconds. Set either cache entry count or TTL to zero to disable it. A normalized request digest includes incident identity, sorted selected services, normalized window, optional trace identity, analysis schema/collector version and provider/model identity. Stored keys additionally include a content-derived evidence snapshot version. Identical concurrent requests share one investigation. Returned objects are cloned.

Reports expose snapshot version, original collection time, latest retained observation time, stale flag, hit/miss/deduplicated status and expiry. Cache hits are explicitly historical snapshots, not recollections. Changes are visible after TTL expiration; there is no push invalidation from observability backends. Timeout, unavailable, malformed, oversized or truncated collections are not cached. AI failures may reuse a cached deterministic report during its TTL, with the original AI status preserved. Unsupported logs or sparse-series limitations may be cached for the short TTL. A historical investigation may legitimately be stale relative to now.

## Incident observability

Existing OpenTelemetry instruments export `incident_analysis_requests_total`, `incident_analysis_duration_seconds`, `incident_analysis_source_failures_total`, `incident_analysis_partial_reports_total`, `incident_analysis_ai_failures_total`, and `incident_analysis_inflight_requests`. Cache requests count as requests; duration and in-flight instruments describe actual analysis work. Source failure labels contain only the fixed source enum. No incident ID, trace ID, exception, customer ID, raw path or query is a metric label.

Safe spans are `incident.collect`, `incident.correlate`, `incident.analyze`, and `incident.ai_enrich`. Only fixed source-type attributes are recorded. Use a distinct `OTEL_SERVICE_NAME=incident-diagnostics` when enabling telemetry for the diagnostic CLI. Diagnostic spans are outside the selected business-service allowlist and are never used as incident evidence, avoiding recursive collection. Existing dashboards and exporters are reused unchanged.

## Report example and validation

A complete synthetic, schema-valid report is checked in as `phase-20-example-report.json`. It is generated from reviewed synthetic metrics and traces, not production data. Real reports explicitly identify partial coverage, source statuses, freshness, observed symptoms and root-cause hypotheses. Evidence IDs referenced by findings, hypotheses and observed graph edges must exist in the report. Confidence never represents numerical probability and no hypothesis can be labeled verified.

## Verification

Use Node 24. The environment's default shell may select Node 22; put the installed Node 24 binary directory first on PATH.

```sh
npm run typecheck
npm run test:incidents
npm run test:observability
npm run test:sql:integration
INTEGRATION_EXECUTION=host INTEGRATION_REPORT_DIR=/tmp/phase20-regression node scripts/integration-runner.mjs --reporter=json --outputFile=/tmp/phase20-regression.json
node --import tsx scripts/incident-live-proof.mjs
```

The live proof creates one random owned observability Compose project, injects synthetic telemetry only into that project, checks actual collectors, checks Grafana provisioning/expression validity, stops its own query backends, checks partial reports, and removes only its own fixtures. It never inspects credentials or mutates existing application containers/databases. The full existing integration harness creates separate owned business fixtures. Do not run multiple heavy harnesses concurrently on a resource-limited Docker host. No live LLM requests are needed.

Actual commands, exact counts, failed attempts, cleanup and remaining gaps are recorded in `phase-20-verification-report.md`. No lint script is configured. No live external AI account, production traffic, statistically calibrated confidence, arbitrary log ingestion, service readiness exporter, queue depth exporter or resource-saturation telemetry is part of this phase.
