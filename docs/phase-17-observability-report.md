# Phase 17 — distributed observability

**Status: INCOMPLETE.** Implementation is present in the authorized development working tree. Live ingestion, datasource/dashboard queries, failure flows and final regression must pass before this status can change. No historical Phase 16 result is used as evidence for Phase 17.

## 1. Starting repository state

The branch was `backend`, HEAD `e501bc4b9a6ba1e346aa64d9d43da1609c5f455c`, with extensive pre-existing uncommitted Phase 1–16 work. Before editing, the 315 source files in the verified Phase 16 manifest matched its hashes. That source belongs to `verification/phase16-final`, commit `f5a3e805424f0cdbb56112fecd95b4bf7906151f`, identity `e4c195627c715fcad9244f445e5e4ea6e9501dd0399e24c5dfbf23f5cc1a59c1`. The development HEAD itself differs from the verification commit; no checkout, merge or cherry-pick occurred.

The initial audit covered service entry points, middleware, clients, pools, messaging, outbox/inbox, saga commits, Search metrics/rebuilds, Compose and the Phase 16 workflow. No existing OpenTelemetry SDK or Prometheus pipeline was active. A private SHA256 inventory captured 366 pre-existing files, including actual env files, before any Phase 17 mutation. The original Git index was also recorded. That inventory is not a publishable source artifact.

## 2. Exact files changed

The final differential file inventory is listed below. Existing dirty files were edited in place to add instrumentation; pre-existing work was not reset or replaced. Phase 16 reports, workflow, source manifest, verification worktree and development env files remain historical inputs.

69 existing files intentionally edited; 41 new files.

- `.gitignore`
- `apps/api-gateway/package.json`
- `apps/api-gateway/src/app.ts`
- `apps/api-gateway/src/server.ts`
- `apps/api-gateway/src/upstream-client.ts`
- `apps/auth-service/package.json`
- `apps/auth-service/src/app.ts`
- `apps/auth-service/src/db/pool.ts`
- `apps/auth-service/src/server.ts`
- `apps/cart-service/package.json`
- `apps/cart-service/src/app.ts`
- `apps/cart-service/src/catalog-client.ts`
- `apps/cart-service/src/redis/client.ts`
- `apps/cart-service/src/server.ts`
- `apps/catalog-service/package.json`
- `apps/catalog-service/src/app.ts`
- `apps/catalog-service/src/db/pool.ts`
- `apps/catalog-service/src/server.ts`
- `apps/inventory-service/package.json`
- `apps/inventory-service/src/app.ts`
- `apps/inventory-service/src/catalog-client.ts`
- `apps/inventory-service/src/checkout-consumer.ts`
- `apps/inventory-service/src/compensation-consumer.ts`
- `apps/inventory-service/src/db/pool.ts`
- `apps/inventory-service/src/expiration-worker.ts`
- `apps/inventory-service/src/inventory-repository.ts`
- `apps/inventory-service/src/inventory-service.ts`
- `apps/inventory-service/src/server.ts`
- `apps/notification-service/package.json`
- `apps/notification-service/src/app.ts`
- `apps/notification-service/src/db/pool.ts`
- `apps/notification-service/src/recipient-resolver.ts`
- `apps/notification-service/src/server.ts`
- `apps/orders-service/package.json`
- `apps/orders-service/src/app.ts`
- `apps/orders-service/src/db/pool.ts`
- `apps/orders-service/src/http-clients.ts`
- `apps/orders-service/src/order-repository.ts`
- `apps/orders-service/src/saga/repository.ts`
- `apps/orders-service/src/server.ts`
- `apps/payments-service/package.json`
- `apps/payments-service/src/app.ts`
- `apps/payments-service/src/checkout-consumer.ts`
- `apps/payments-service/src/db/pool.ts`
- `apps/payments-service/src/mock-provider/config.ts`
- `apps/payments-service/src/payment-service.ts`
- `apps/payments-service/src/provider-client.ts`
- `apps/payments-service/src/refund-service.ts`
- `apps/payments-service/src/server.ts`
- `apps/search-service/package.json`
- `apps/search-service/src/app.ts`
- `apps/search-service/src/catalog-client.ts`
- `apps/search-service/src/elasticsearch.ts`
- `apps/search-service/src/projector.ts`
- `apps/search-service/src/rebuild.ts`
- `apps/search-service/src/server.ts`
- `compose.yaml`
- `infrastructure/docker/notification-service.Dockerfile`
- `infrastructure/docker/search-service.Dockerfile`
- `package-lock.json`
- `package.json`
- `packages/event-persistence/package.json`
- `packages/event-persistence/src/common.ts`
- `packages/event-persistence/src/inbox/processor.ts`
- `packages/event-persistence/src/outbox/repository.ts`
- `packages/messaging/package.json`
- `packages/messaging/src/connection.ts`
- `packages/rate-limiting/package.json`
- `packages/rate-limiting/src/redis-store.ts`
- `.env.observability.example`
- `.github/workflows/phase17-observability.yml`
- `compose.observability.yaml`
- `docs/phase-17-observability-report.md`
- `docs/phase-17-observability-results.json`
- `docs/phase-17-observability-runbook.md`
- `infrastructure/observability/collector.yaml`
- `infrastructure/observability/grafana/dashboards/dependencies.json`
- `infrastructure/observability/grafana/dashboards/http-performance.json`
- `infrastructure/observability/grafana/dashboards/inventory-compensation.json`
- `infrastructure/observability/grafana/dashboards/orders-payments.json`
- `infrastructure/observability/grafana/dashboards/rabbitmq.json`
- `infrastructure/observability/grafana/dashboards/search-performance.json`
- `infrastructure/observability/grafana/dashboards/service-overview.json`
- `infrastructure/observability/grafana/provisioning/dashboards/dashboards.yaml`
- `infrastructure/observability/grafana/provisioning/datasources/datasources.yaml`
- `infrastructure/observability/prometheus.yaml`
- `infrastructure/observability/tempo.yaml`
- `packages/observability/bootstrap.d.mts`
- `packages/observability/bootstrap.mjs`
- `packages/observability/config.d.mts`
- `packages/observability/config.mjs`
- `packages/observability/package.json`
- `packages/observability/src/commits.ts`
- `packages/observability/src/config.ts`
- `packages/observability/src/context.ts`
- `packages/observability/src/dependencies.ts`
- `packages/observability/src/events.ts`
- `packages/observability/src/index.ts`
- `packages/observability/src/metrics.ts`
- `packages/observability/src/middleware.ts`
- `packages/observability/test/integration.proof.ts`
- `packages/observability/test/observability.test.ts`
- `packages/observability/test/runtime-fixture.mjs`
- `packages/observability/test/runtime.test.ts`
- `packages/observability/tsconfig.json`
- `scripts/observability-benchmark.mjs`
- `scripts/observability-compiled-smoke.mjs`
- `scripts/observability-runner.mjs`
- `scripts/observability-static.mjs`
- `vitest.observability.config.mjs`

## 3. Architecture and versions

Services use the shared SDK and send OTLP HTTP asynchronously to the Collector. The Collector sends traces to Tempo and exposes one Prometheus exporter endpoint, scraped by Prometheus. Grafana uses those two provisioned datasources. There is no second application Prometheus endpoint or duplicate metric pipeline.

Pinned cohort: API 1.9.0; core/resources/trace/metrics SDKs 2.12.0; OTLP HTTP exporters 0.223.0. Node 24.21.0 ran the local checks. Only these selected packages were installed; no blanket auto-instrumentation bundle was added. npm installation reported zero dependency vulnerabilities at installation time.

Images: Collector Contrib 0.162.0, Prometheus 3.13.4, Tempo 2.10.8, Grafana 13.1.6. Tempo deliberately uses its monolithic 2.10 line. Version pinning and startup alone do not prove end-to-end compatibility. Relevant primary sources: [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js), [ESM preload guidance](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md), [Collector release](https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.162.0), [Tempo Collector setup](https://grafana.com/docs/tempo/latest/set-up-for-tracing/instrument-send/set-up-collector/otel-collector/), and the [Prometheus](https://github.com/prometheus/prometheus/releases), [Tempo](https://github.com/grafana/tempo/releases) and [Grafana](https://github.com/grafana/grafana/releases) release records.

## 4. SDK initialization

All nine service startup scripts use an explicit `--import` preload. Containerized Search and Notification commands do likewise. A server's bootstrap import is an idempotent guard, not the mechanism relied on to order ESM sibling imports. A global initialization latch and state prevent duplicate registration. Bootstrap/config are MJS with declarations, independent of TypeScript loading.

Disabled mode returns before importing any SDK/exporter. Enabled mode validates configuration and initializes without waiting for a backend. Invalid configuration fails open with a fixed diagnostic, without logging rejected values. Defaults: false; parent-based root ratio 0.1; queue 512; batch 128; concurrency one; export/shutdown 1000ms; metric interval 5000ms. Bounds are validated. Span limits are 16 attributes/128 characters, zero events and one link; metric cardinality is capped at 128 attribute sets per instrument. SDK flush/shutdown race a deadline. Signal hooks do not own process exit or change business shutdown deadlines.

The compiled smoke check transpiles the actual shared package, preserves its relative config/bootstrap layout and verifies the preload is active before importing Express. Existing workspace exports remain TypeScript; a compiled application that keeps those exports needs the existing TS loader or a properly compiled deployment package. No new application build system was introduced.

## 5. HTTP propagation and request IDs

Each service has one inbound middleware. W3C traceparent/tracestate are validated by the propagator; oversized headers and arbitrary baggage are not extracted. HTTP client headers are injected under the client span, so downstream server parentage corresponds to that client span. Authentication headers and existing client deadlines/redirect rules are retained.

Gateway retains its existing generated request ID. Enabled downstream middleware accepts only the bounded internal request ID, otherwise uses its existing ID or a UUID. Request IDs are separate from trace IDs. Structured HTTP completion, messaging, persistence, saga and Search records can contain requestId/traceId/spanId/service. No raw span object is logged. New HTTP completion logging drops a record if stdout already has at least 64KiB queued; it does not wait for a log sink. Disabled middleware adds neither IDs nor headers and does not replace existing request-ID behavior.

## 6. RabbitMQ, outbox and worker context

Producer spans cover the existing send and publisher confirmation. Consumer spans cover delivery processing, including the existing retry/DLQ decisions. Handled consumer failures still mark the span ERROR. Existing event envelopes, signatures, IDs, retry counts, confirms, manual ACKs, NACK/reconnection behavior and inbox deduplication are retained. Enabled retry/DLQ handoffs preserve application headers while updating the existing disposition headers and injecting the new producer context.

The actual outbox schema has no durable trace carrier. A bounded 512-entry, five-minute, in-process map captures context at outbox insertion and restores it at publish. Payment intent handlers also retain in-process context for the asynchronous payment worker. RabbitMQ carries W3C headers after publication. This is best-effort correlation, not durable trace continuity: restart/eviction/backlog expiry may create a new trace. No SQL, schema, signed payload or atomicity was changed to store trace metadata. Business correlation/event IDs remain authoritative across this gap. New producer/consumer spans express the asynchronous handoffs; their durations do not imply one synchronous HTTP operation.

## 7. HTTP metrics

Instruments: `http.server.requests`, `http.server.errors`, `http.server.request.duration`, `http.client.request.duration`. Counters count requests and 5xx server errors. Histograms use seconds and explicit millisecond-to-ten-second latency boundaries. Dimensions are finite method, registered route template, status/outcome and resource service. Request/trace IDs, raw URLs and query strings are excluded. Generic HTTP client duration ends at response headers; Elasticsearch's separate wrapper includes body parsing/classification. The default metric-name translation is expected to add Prometheus `_total` and `_seconds` suffixes; live retrieval must confirm it.

## 8. Business and messaging metrics

`business.observations` uses a finite operation union and outcome success/error/observed. Order creation is counted after COMMIT. Saga completion/failure/compensation observations are queued against the client and flushed only by the transaction owner after COMMIT; rollback/finally clears the queue. The pending callback list is weakly keyed and capped at 128. Inventory inbox successes/failures and compensation outcomes are emitted only after a processed commit, excluding inbox duplicates. Expiration observes committed batch outcomes. Claimed payment/reconciliation work counts attempts; terminal results and refunds are observations after the fenced finish returns. Search projection completion/failure and completed rebuild/reconciliation outcomes are observed; `search.rebuild.duration` has separate longer-duration buckets.

These are not unique financial or exactly-once counters. Reclaimed leases, repeat public idempotent calls, at-least-once Search deliveries and crash gaps can repeat or omit observations. Durable databases are the source of truth. Messaging metrics cover publish, acknowledged processing, errors, duration, confirmed retry and confirmed dead-letter handoffs. No success is emitted before the associated business transaction commits.

## 9. PostgreSQL

Pool/client factories use a weakly cached proxy. Promise and callback APIs retain arguments, return shape, errors, release/event behavior and options. Explicit client queries and pool.query each have one owner; there is no automatic SQL patch or double instrumentation. Callback continuation restores the caller's context after the dependency span ends. Attributes contain system and a fixed operation keyword, never SQL text, parameters, connection strings or credentials. Pool limits, statements, transactions, commit order and deadlines are unchanged. Migration-only CLI pools are not instrumented. Streaming query APIs are outside the application paths verified here.

## 10. Redis

Cart and distributed rate-limit clients use the shared proxy. Command-option clients retain their timeout options and instrumentation. Lua remains byte-for-byte unchanged, and instrumentation issues no additional Redis command. Multi builders preserve chaining and instrument EXEC rather than every queued operation. Only command categories/system are recorded; keys, values, arguments and Lua source are excluded. Real Redis spans still require the live proof.

## 11. Elasticsearch

One wrapper owns the complete existing request, including response body parsing and the existing accepted-status/error classification. It exports only system, operation, duration and fixed error status. Search terms, bodies, credentials, paths and signed internal tokens are excluded. External versions, tombstones, aliases, rebuild phases, reconciliation, request deadlines and authoritative Catalog visibility are unchanged.

## 12. Collector

Contrib was selected for its Prometheus exporter. The original pinned image accepted the Collector configuration in a no-network validation container. The final pinned-image validation passed for the OpenMetrics-enabled configuration at a 512MiB container limit. OTLP HTTP is internal 4318, host-loopback published; the Prometheus endpoint 8889 is internal only. Memory limiter 384MiB/spike64, batches 128/max256, trace export timeout 1s, queue256/one consumer, retries max elapsed5s. OpenMetrics output is enabled. There is one metrics pipeline and one trace pipeline.

## 13. Prometheus

Prometheus scrapes only `otel-collector:8889` every five seconds. Retention is 24 hours/256MiB; storage is disposable tmpfs. There is no remote-write duplication. The pinned image's promtool accepted the final configuration. Actual data and PromQL remain unverified until the live proof succeeds.

## 14. Tempo

Tempo receives OTLP from the Collector on the internal network. The query API binds to host loopback. Local WAL/blocks use tmpfs, one-hour retention and five-minute blocks. Internal authentication is disabled for this isolated local network; this is not a production access-control deployment. A container-start log is not trace ingestion proof. Retrieval by a known business-flow trace ID is required and is currently outstanding.

## 15. Grafana dashboards

Stable Prometheus/Tempo datasource UIDs and seven dashboards are provisioned: service overview; HTTP performance (p50/p95/p99); RabbitMQ processing; orders/payments; inventory/compensation; Search; dependency latency. Queries reference the chosen emitted instruments and their expected translated labels. The live verifier checks both datasource health endpoints, dashboard count and every PromQL expression, then reports series counts. JSON structure checks are separate from live PromQL/data verification.

Anonymous access/signup are disabled. Login uses a generated/local secret file, no committed password. Exemplar datasource navigation is provisioned and the Collector can expose OpenMetrics. The selected JS SDK does not expose exemplar data in its metric data types; no working metric-to-trace exemplar path is claimed. Explicit trace-ID navigation is the supported proof path for this implementation.

## 16. Security and defaults

Span/metric attributes were audited at each call site. There are no exported passwords, JWTs, cookies, authorization headers, API keys, private keys, full request/event/customer records, raw error messages, SQL parameters, Redis keys or search terms. Metric cardinality is bounded, with no identity labels. Valid trace headers affect tracing/sampling only, never authorization. Parent-based sampling can respect an upstream sampled flag; queue/cardinality/time limits remain in effect.

The Compose file is an explicit optional overlay/profile, not part of default startup. All published ports bind loopback. Per-service resource limits are Collector512MiB, Prometheus384MiB, Tempo512MiB and Grafana512MiB, one CPU each. Normal startup has no telemetry depends_on. Actual application env files were not modified; the new example remains false. No development data volume is used by the telemetry stack or verifier. Existing root Docker allowlists already exclude local secret files.

## 17. Failure isolation

Fresh-process tests cover disabled initialization, invalid configuration, unavailable Collector, exporter callback timeout, queue saturation/drop and shutdown during a stalled exporter. A business error is rethrown unchanged and only fixed classification enters spans. Export/flush/shutdown are bounded and never awaited by production request/ACK paths.

The prepared live proof stops each exact owned Collector/Tempo/Prometheus/Grafana service in turn and asserts committed checkout completion, one charge, correct stock, ACK and successful Search. Its complete actual-backend failure cases have not executed yet. Restart/ingestion recovery needs live verification. Disabled full-regression results do not establish enabled financial behavior during backend failures.

## 18. Performance overhead

Three alternating fresh-process comparisons: 200 HTTP warmups, 2,000 requests at concurrency five and 1,000 awaited async operation fixtures per mode. Both modes use the same response/workload; enabled uses 10% sampling and an unavailable local Collector. Measured process CPU, 25ms-sampled peak RSS/heap, latency, throughput and async operation durations. New logging formatting is included, with output discarded by the benchmark parent. Export shutdown is outside the HTTP timing interval.

Final benchmark medians: disabled/enabled HTTP p50 0.810/1.071ms, p95 3.065/3.755ms, p99 4.993/5.945ms; throughput 4,560.8/3,580.9 requests/s; CPU 134.54%/131.48% of one core; peak RSS 193.19/197.48MiB; heap 57.23/58.63MiB; async fixture p95 0.0041/0.0109ms. Relative p95 was about +22.5%, throughput about -21.5%. CPU percentage alone does not mean less CPU per request: dividing CPU use by throughput gives approximately 0.295/0.367 CPU-ms per request.

This is a small local microbenchmark, with concurrent local Docker activity and GC/scheduling noise. Async fixtures are not a broker throughput benchmark. It does not establish production scalability or real RabbitMQ overhead. Live Collector performance and real messaging comparisons are outstanding.

## 19. Unit/static tests

Node 24.21.0; strict typecheck passed. No lint script exists. Compiled preload smoke passed. The local portable harness test suite passed. Observability unit/runtime verification covers correlation, W3C/baggage, header preservation, safe metrics, business errors, callback/Promise/Lua behavior, command-option clients, post-commit/rollback and bounded exporters. Exact final counts are recorded in the execution summary below. Test HTTP listeners are ephemeral loopback listeners.

## 20. Integration tests and attempts

Four live attempts used random owned projects. All failed during backend query readiness, before business proof/ingestion/datasource/PromQL checks. Two subsequent attempts recorded `UND_ERR_SOCKET`; the last, with corrected secret permissions and aligned memory limits, ended on an HTTP readiness timeout. Containers had startup/process evidence but this did not establish queryability. All four projects were removed and ownership checks found no remaining containers. The Collector validation container later exited successfully. Collector/Grafana memory bounds were increased, the Collector limiter was aligned, and secret permissions were corrected for an unprivileged Grafana process. Final static validation passed, but the last live attempt still failed at query readiness. These observations do not isolate the underlying cause.

The prepared proof uses actual Gateway/Orders APIs, separate disposable service schemas, real outbox/inbox and RabbitMQ, payment provider fixture, Inventory and existing Search fixture/Elasticsearch. It checks charge/stock outcomes, shared request IDs, correlated logs, producer/consumer/dependency trace retrieval, Prometheus data and Grafana health. These components run in a test process with an observability-proof resource; this is component integration, not a nine-process deployment certification.

## 21. Full regression

The existing portable `scripts/integration-runner.mjs` owns fresh PostgreSQL, RabbitMQ, Redis and Search stores, generated env files and all teardown. An initial run began while final audit fixes were still being made; it is preliminary, not final-source certification. It reported 957/970 passing, 13 failing, zero skipped. Failures included database/broker connection timeouts, Search readiness/hooks and one Redis command-option instrumentation assertion against already-loaded earlier code. That instrumentation gap was fixed and passed a fresh unit run. Original business assertions and application/test deadlines were not weakened.

The second iteration reported 936/970 passing, six failures and 28 pending/unexecuted tests after hook failures. Errors included RabbitMQ recovery deadlines, Search cleanup/readiness and Redis recovery/latency assertions. Its owned cleanup passed. A closed-SDK lifecycle guard was added after this iteration began, and a subsequent real HTTP parentage unit case raised the current unit count to 23; neither iteration certifies the final source. Final-source regression remains outstanding. Historical 948/948 Phase 16 results remain untouched and do not count toward Phase 17.

## 22. Unexecuted tests and CI

Live OTLP ingestion/trace retrieval/metrics/Grafana/PromQL, actual-backend outage/restart flows and real messaging performance remain outstanding unless the final execution summary explicitly records a pass. There are no skipped-unit substitutions for these checks. The prepared manual-dispatch Phase 17 workflow uses Ubuntu24.04/Node24.21.0 with static, unit, isolated proof, full regression twice and overhead stages. It has not been committed, pushed, registered, dispatched or run remotely. The Phase 16 workflow and reports are unchanged. No paid/larger runner was provisioned.

## 23. Resource cleanup and preservation

Only random owned telemetry/test projects and a disposable no-network config validation container were controlled. There was no global prune, Docker resize, removal of development volumes, database reset, development migration or stop of unrelated containers. Temporary envs/passwords live outside the repository and are removed with owned cleanup. Sanitized count/performance/ownership evidence may be retained; raw envs, credentials and diagnostic payloads are not published.

Final preservation checks compare the initial 366-file inventory and Git index. Intended instrumentation edits are distinguished from original development data/history. Exact cleanup and preservation outcomes appear below; an incomplete cleanup is never labeled successful.

## 24. Remaining risks

Final regression and full live verification are required. This Docker Desktop has about 7.75GiB configured and many unrelated running containers; the historical Linux runner's 14GiB planning floor was not reduced. Backend startup/forwarded sockets and business-store deadlines have been unreliable locally. Connection failures are evidence of an incomplete test run, not proof that every failure is environmental. Do not bypass them by extending application deadlines or weakening assertions.

Trace continuity is best-effort across durable worker restarts; counters are observations; sampling can make a logged trace ID unqueryable; generic HTTP client duration is response-header time; streaming PG/custom unused Redis APIs are outside tested paths; tmpfs telemetry is lost on teardown. No production scale, unique business metric, verified exemplar or remote CI claim is made.

## 25. Final phase status

**INCOMPLETE: full regression failed and required live checks did not execute.** Branch/HEAD remain `backend`/`e501bc4b9a6ba1e346aa64d9d43da1609c5f455c`; Phase 17 is uncommitted working-tree work. No unauthorized Git operation occurred. No Phase 18 work began.

### Final execution and preservation summary

- Strict typecheck, MJS syntax and compiled preload: passed on Node24.21.0.
- Portable harness: **35/35 passed**, zero failed/skipped.
- Observability: **23/23 passed**, zero failed/skipped. Includes actual loopback HTTP client/server parentage and request-ID correlation, plus six fresh-process lifecycle/failure cases.
- Final Collector/Prometheus/Compose configuration and seven dashboard structures: passed. The earlier lower-memory static validation timed out; its owned cleanup also passed.
- Live proof: **setup failed in four attempts; 0/5 proof cases executed**. No ingestion, trace retrieval, live metrics/PromQL, datasource health or real-backend business outage result is claimed.
- Regression attempts: **957/970 (13 failed, 0 pending)** and **936/970 (6 failed, 28 pending/unexecuted)**. No final-source pass. Original timeouts/assertions were retained. The host probe observed a maximum PostgreSQL query of **4,852ms**, zero failed probe queries and a maximum timer gap of **1,012ms**; this is responsiveness evidence, not an explanation of every failure.
- Cleanup: all four telemetry projects, both static validation projects and the full-regression store project confirmed owned cleanup. Temporary password/env directories were removed. No failed-run container or development volume was intentionally retained/removed.
- Preservation: **0 original files deleted**, **21 protected env/history/manifest files unchanged**, Git index unchanged, branch/HEAD unchanged. The 69 original-file edits are the listed instrumentation/config changes. Existing dirty work and its historical reports were preserved; verification used only generated test endpoints and disposable stores.
- Safety: false opt-in default; no committed secret; no commit, push, branch/main modification, deployment, remote workflow execution, global prune or Phase18 work.

Machine-readable sanitized evidence: [phase-17-observability-results.json](phase-17-observability-results.json). Setup/cleanup steps: [phase-17-observability-runbook.md](phase-17-observability-runbook.md).

Completion requires a responsive isolated environment and a final-source regression with no failed/skipped/unexecuted required checks. This repository state is reviewable implementation with verified static/unit behavior, not a completed Phase17 certificate.

