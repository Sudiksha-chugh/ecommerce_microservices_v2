# Phase 21: performance investigation

This backend-only, opt-in diagnostic facility collects bounded evidence, validates span graphs, computes an observed dominant timeline, produces deterministic findings and priorities, and optionally enriches the summary. Engineers review all recommendations. No recommendation executes an action.

## Architecture and reuse

`@ecommerce/observability/performance` is a reusable package subpath. Keeping it in the existing observability package permits direct reuse of Phase 20's fixed Prometheus queries, bounded transport, Tempo envelope and identifier validation without creating a new service or duplicating provider transport. No dependency or lockfile change is required.

The flow is approved request → five bounded sources → allowlisted evidence → graph validation and interval analysis → deterministic correlation/findings → deterministic priorities → optional constrained narrative → runtime-validated report. Sources are Prometheus, Tempo trace-ID lookup, local Phase 18 SQL snapshots and optional operator-provided numeric resource/queue snapshots. The API cannot upload snapshots.

Phase 17 supplies instrumentation, SDK, metrics and dashboards. Phase 18 supplies sampled query fingerprints/aggregates; Phase 19 supplies candidate selection and the fixed AI transport. Phase 20 supplies query templates, transport, sanitization and internal authentication conventions. Shared `diagnostic-router.ts` and `narrative-ai.ts` preserve the incident public interfaces while supporting performance reports. Existing incident, advisor, SQL and observability tests remain in the regression suite.

## Trace algorithm: observed-envelope-v1

Each span retains only validated trace/span/parent IDs, an allowlisted service, timestamps, normalized operation/dependency/kind, nullable explicit error status and an optional validated query fingerprint. Raw span names, arbitrary attributes, URLs, headers, error messages and SQL text are discarded.

Validation detects duplicate IDs, missing parents, cycles, excessive depth, negative duration, timestamp/range violations, truncation, multiple roots and any child interval outside its parent. Request operation and selected services must match. An incomplete graph retains valid observations with explicit issues; end-to-end attribution, parent-exclusive values and dominant paths are suppressed. Clock skew is not silently corrected.

For a valid rooted graph:

1. End-to-end duration is root end minus root start.
2. Each parent's child coverage is the union of its direct children's clipped intervals. Sort intervals and merge intersections/touching endpoints. Parent-exclusive time is duration minus that union.
3. Partition the root envelope at all span boundaries. For each elementary interval, recursively choose the active child with the latest end, breaking ties by span ID. Merge adjacent selections of the same span. These nonoverlapping intervals cover the root exactly; their durations sum to root duration.
4. Per-service estimated dominant time sums only those selected intervals. Observed service time separately unions all spans belonging to that service. Inclusive unions across services can overlap and must not be added as latency contributions.
5. Report root direct-child overlap as sum of direct-child durations minus their union. Report root uncovered time as unattributed; do not sum uncovered time across nested parents.

For two simultaneous 300 ms children in a 500 ms parent, child coverage is 300 ms, overlap is 300 ms and uncovered time is 200 ms. The children do not contribute 600 ms to response time.

The `criticalPath` DTO is explicitly an **estimated observed dominant envelope**, not a verified scheduling/causal DAG. Parent links alone do not show awaits, asynchronous continuation or dependency constraints. Reducing a selected span does not imply an equal end-to-end improvement. A representative trace cannot establish workload p95 contribution. Uncovered parent time may represent instrumentation gaps, waiting or work; it is never assigned to CPU.

## Evidence and correlation

Evidence IDs are stable hashes of sanitized values. Every finding and priority references existing evidence; report validation checks span identity, path coverage, selected services, source provenance and SQL relations. Collection timestamps, source status/reasons, coverage and cache freshness are explicit. Missing required sources keep the report `partial`.

Metrics reuse the six actual Phase 20 templates: service HTTP latency percentile, throughput, error ratio, PostgreSQL latency percentile, messaging retry rate and business-failure rate. Service rolling percentile peaks are not operation-filtered percentiles. Correlation requires matching service and overlapping evidence windows with a documented five-second tolerance. It produces correlated behavior or hypotheses, not causality.

SQL evidence uses an in-memory `sqlTelemetrySnapshot()` and `advisorCandidates()` only. Histogram structure and aggregate consistency are revalidated. Sampled maximum latency and retained sampled counts are reported at snapshot capture time. The monotonic retention store cannot supply exact investigation-window UTC query frequency; SQL coverage remains partial. Dedicated diagnostics normally have no service-owned SQL snapshot, so SQL is unavailable there. A hosting integration may supply an approved local snapshot reader with a valid service identity. No remote cross-service SQL collection is claimed.

A trace span and sampled SQL aggregate link only when both carry the same validated fingerprint and service. This is a query-shape association, not an individual execution or latency match. Without those fields there is no link. No query, automatic EXPLAIN, index or plan retrieval is performed. Existing reviewed deterministic plan findings may be inspected separately through Phase 18/19; this report does not fabricate them.

## Findings and priorities

Reviewed deterministic thresholds enable downstream latency (200 ms), database-heavy representative spans (100 ms and at least half the root envelope), retry/slow-span coincidence, at least three nonoverlapping dependencies, large uncovered parent intervals (200 ms and half the parent), service latency percentile peaks (1 s), explicit-error slow spans, repeated sampled SQL (100 ms, ten observations), and incomplete instrumentation.

Optional approved snapshots enable queue delay (100 ms), resource utilization/pressure (0.8) and event-loop lag (50 ms). Current exporters do not provide those default resource/queue signals. External API classification is disabled: existing HTTP dependency telemetry does not distinguish internal and external destinations. No unsupported metric names or findings are invented.

Priority scores are ordinal investigation ordering: severity gives 10/30/50 points, each source type five, an estimated dominant interval ten, temporally correlated throughput ten, and direct observation five; cap 100. Thresholds are high ≥60, medium ≥35, otherwise low. Stable finding ID breaks ties. Confidence, reasons, evidence, limitations and validation steps accompany every priority. Scores do not forecast performance gains.

## AI and security

AI is off by default. Explicit offline mode returns a deterministic allowed summary. The optional OpenAI provider reuses Phase 19's fixed Responses transport with a strict enumerated summary schema, no executable tools and `store:false`. See the [official structured-output documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). Only normalized finding categories/severity/confidence/classification, ordinal priorities and coverage enter its prompt. No raw trace, SQL, IDs, fingerprint, customer data or arbitrary prompt is sent.

The shared narrative gate validates allowed output, preserves all deterministic evidence/values/rankings, bounds tokens, requests, concurrency, duration and circuit-breaker behavior. Provider failure leaves deterministic results authoritative. Tests use offline/local providers only; live provider operation is unverified.

All backend destinations are operator-configured literal loopback HTTP origins. Paths and queries are fixed, redirects fail, and bodies have byte/sample/time limits. Request-provided URLs, PromQL, TraceQL, SQL, shell commands and prompts are rejected by strict schemas. Unknown fields and query parameters fail. Untrusted telemetry is structurally projected and revalidated; raw evidence/prompts are not logged or cached.

## Internal API and operations

Set `PERFORMANCE_DIAGNOSTICS_ENABLED=true` and configure existing admin public-key JWT settings plus `PERFORMANCE_PROMETHEUS_ORIGIN`/`PERFORMANCE_TEMPO_ORIGIN`. Copy values from `.env.performance-investigation.example` into operator-managed configuration; the script does not automatically load that example. Run with Node 24 and an explicitly supplied environment:

```sh
npm run performance:diagnostics
```

The existing diagnostic host listens on `127.0.0.1`, port `INCIDENT_DIAGNOSTIC_PORT` (default 3219). It can run performance-only or share the incident host; the existing SQL diagnostic host can also conditionally mount the router. There is no Gateway/business-route mount or new microservice.

Admin JWT authentication and role authorization protect all endpoints:

- `GET /internal/performance/health`
- `GET /internal/performance/capabilities`
- `POST /internal/performance/analyze`

The strict body contains `startTime`, `endTime`, unique allowlisted `services`, up to four nonzero 32-character hexadecimal `traceIds`, and a validated `operation` (default `all`). Operations are checkout, search, authentication, catalog, cart, payment, refund, inventory, notification and all. Representative discovery is unavailable; absent trace IDs yield a coverage gap. Responses are `no-store`; invalid requests return 400, authentication 401, authorization 403, admission overload 429 and sanitized internal failure 503.

## Limits, cache and failure isolation

Defaults: one-hour window, nine services, four traces, 250 spans per trace, graph depth 32, 5,000 metric samples, 128 evidence records, 128 KiB evidence, 1 MiB backend response, 256 KiB report, 1.5 s backend timeout, ten-second investigation deadline, two investigations and twenty authenticated admissions per minute. Strict bounded `PERFORMANCE_LIMIT_*` environment overrides exist; capabilities publishes effective limits.

Five collectors run independently within admission capacity. Physical slots remain reserved until collector promises actually settle, including after an uncooperative source exceeds the returned-report deadline. Outages, malformed/oversized responses, invalid graphs and missing series produce partial coverage. Whole graphs are retained or omitted under evidence limits; a truncated graph is never falsely attributed. Report oversize drops detail with an explicit bounded partial report.

Concurrent identical requests deduplicate. Cache TTL defaults to 15 seconds, maximum 32 entries. Keys include canonical request, schema/collector version, provider/model identity and a sanitized evidence snapshot digest. Failures/truncation/incomplete graphs are not cached. Only sanitized reports are stored. Collected timestamps remain original; staleness defaults to five minutes and is recomputed on hits. TTL bounds reuse; it cannot detect unseen backend changes before expiration.

Diagnostics do not run in checkout, payments, refunds, inventory, search or consumer paths. They open no database connection and possess no business-mutation/remediation interface. The optional SQL reader snapshots existing process memory. Verification infrastructure owns fresh projects/credentials/ports and removes only its own stores and volumes.

## Observability and verification

Six lazy, low-cardinality metric instruments expose request count, duration, source failure, partial reports, AI failures and inflight count under `performance_investigation_*`. Only bounded source labels are added. Safe spans are `performance.collect`, `performance.trace_analyze`, `performance.correlate` and `performance.ai_enrich`. No trace ID, fingerprint, raw path, exception or customer identifier becomes a metric label.

The `commerce-performance-investigation` Grafana dashboard contains six real metric panels against the existing `prometheus` datasource; it does not duplicate service latency dashboards.

Run `npm run test:performance`, `npm run test:observability`, `npm run typecheck`, the existing isolated PostgreSQL/Redis/Search/full runners and `npm run verify:observability`. `scripts/performance-live-proof.mjs` exercises measured fixture HTTP/SQL spans, real Prometheus/Tempo, authenticated API, query-shape links, AI failure, six panels and controlled owned-backend outages. Fixture traffic is synthetic; it is not a production load test. Verification counts, exact commands, source digest, historical failed attempts and final verdict belong in [the verification report](phase-21-verification-report.md).

The live synthetic fixture inserts three-millisecond waits after measured dependency groups so its independent SDK start/end clock sampling yields a coherent representative graph. Production graph validation is unchanged: any observed child outside its parent still suppresses attribution. Raw synthetic diagnostic captures from failed attempts are temporary verification artifacts, not API output or application logs.
