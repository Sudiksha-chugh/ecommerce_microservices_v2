# Phase 17 observability runbook

Phase 17 is opt-in and still requires the live verification described in the report. The existing application does not need any of these backends to start. Do not use telemetry to authorize a request or decide an order, payment, reservation, ACK, retry, or compensation outcome.

## Enable and start

Use Node 24.21.0 and the existing workspace scripts. They preload the SDK before service libraries. Keep `OTEL_ENABLED=false` for normal development. To opt in for a host service, set these variables in that service's environment:

```sh
export OTEL_ENABLED=true
export OTEL_SERVICE_NAME=orders-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_TRACES_SAMPLER_ARG=0.1
npm run dev:orders
```

Each service has its own name (api-gateway, auth-service, catalog-service, cart-service, orders-service, payments-service, inventory-service, notification-service, search-service). Server entry points infer the name from their path if the name is omitted. In deployments with a custom entry point, set it explicitly. The SDK accepts only validated, bounded configuration; invalid enabled configuration logs a fixed rejection code and leaves telemetry disabled. No backend connection is awaited at startup. `.env.observability.example` describes the supported knobs; it does not enable any service automatically.

Create a local password file once, without overwriting an existing file:

```sh
mkdir -p .secrets
chmod 700 .secrets
(umask 077; test -e .secrets/observability-grafana-password || openssl rand -hex 24 > .secrets/observability-grafana-password)
chmod 444 .secrets/observability-grafana-password
```

Compose binds file secrets without remapping their host ownership. The password is readable by Grafana's unprivileged UID inside its read-only mount; the host directory must remain mode 700 so other host users cannot traverse it.

Start only the opt-in telemetry stack:

```sh
docker compose -p commerce-v2-observability-local -f compose.observability.yaml --profile observability up -d
```

The standalone stack uses loopback OTLP port 4318, Tempo query port 3200, Prometheus 9090 and Grafana 3000. Override `OTEL_HTTP_PORT`, `TEMPO_PORT`, `PROMETHEUS_PORT`, or `GRAFANA_PORT` if an existing process owns a port. Set `OBS_GRAFANA_PASSWORD_FILE` if your password is elsewhere. Store files outside version control. Do not print application env files or credentials into verification reports.

To connect the containerized Search/Notification services, combine `compose.yaml` and `compose.observability.yaml` under the **same existing Compose project and network**, supplying the application's existing env files exactly as before. Their OTLP endpoint defaults to `http://otel-collector:4318` and telemetry remains false unless explicitly enabled. There is no `depends_on` requirement on telemetry. Do not point a container at its own loopback to reach the Collector.

For compiled deployments, preload `packages/observability/bootstrap.mjs` before the entry point, retain the package's relative `src`/bootstrap/config layout, and compile its TypeScript imports to JavaScript. This repository's workspace packages export TypeScript; an application build that keeps those exports also needs the existing `tsx` loader. `node scripts/observability-compiled-smoke.mjs` checks a compiled shared package with the actual preload.

## Grafana and trace correlation

Open http://127.0.0.1:3000 and sign in as `observability-admin` with your local password file. Anonymous access and signup are disabled. Prometheus and Tempo are provisioned with stable datasource UIDs; seven dashboards appear in the Ecommerce folder. In Explore, select Tempo and enter a trace ID from an enabled structured log. A direct check is `GET http://127.0.0.1:3200/api/traces/<traceId>` with `Accept: application/json`.

Request IDs and trace IDs remain separate. Gateway generates its existing request ID; downstream telemetry preserves the validated internal `X-Request-Id`. Look for `requestId`, `traceId`, `spanId`, and `service` in HTTP completion, messaging, inbox/outbox, saga, and Search logs. Trace/request IDs are not metric dimensions. Sampling can mean a correlated trace ID has no stored spans. W3C `traceparent` and `tracestate` propagate; arbitrary baggage is not extracted.

Outbox and payment-worker handoffs retain a bounded, five-minute, 512-entry **in-process** carrier cache. RabbitMQ headers carry the context once published. A process restart, eviction, or long backlog may start a new trace; durable event IDs and business correlation IDs remain authoritative across that gap. The cache does not alter envelopes, signatures, SQL, or atomicity. Trace IDs must not be used for idempotency.

Exemplar datasource navigation is provisioned but has not been verified; use explicit trace IDs until the live verifier retrieves an exemplar and its trace.

## Investigate an order and RabbitMQ

First check the existing order/saga status and payment reconciliation state using the authenticated application APIs. Search logs by the existing order, event and correlation IDs, then use a log's trace ID in Tempo. Inspect HTTP, PostgreSQL, producer-confirm and consumer-processing spans. A successful ACK is a transport observation, not proof that a saga is complete. A missing sampled trace does not justify a payment retry.

The Orders/payments dashboard uses `business_observations_total` with finite `operation` and `outcome` labels. Observations are not unique financial transactions. Saga completion/failure/compensation hooks flush after the owning transaction commits. The inventory inbox path does not count duplicates as successful reservations. Public idempotent reservation calls and reclaimed payment/refund work can repeat observations; consult durable records for unique counts.

Use the RabbitMQ dashboard for process/error rates, processing latency, retry and dead-letter activity. Confirm delivery disposition in the existing broker/DLQ and structured messaging logs. Instrumentation does not change confirm deadlines, retry counters, ACK/NACK, inbox deduplication or outbox fencing. Consumer errors mark the processing span even when the existing wrapper handles the error through retry or DLQ.

## Investigate Search and dependencies

The Search dashboard filters HTTP route-template latency, projection outcomes, reconciliation/rebuild observations and rebuild duration. The dependency dashboard separates PostgreSQL, Redis and Elasticsearch operation categories. Elasticsearch duration includes body parsing and the existing error classification. No search terms, full URLs, SQL text/parameters, Redis keys/values, authentication headers, message bodies or exceptions are exported as span attributes.

Inspect authoritative Catalog visibility, existing projection receipts/versioning and the active alias before taking recovery action. Use the existing rebuild/reconciliation APIs and flags; tracing does not change external versions, tombstones or alias swaps. Search projection metrics are completed processing observations and can repeat after at-least-once delivery.

## Failure, retention and shutdown

Application SDK defaults: 10% parent-based root sampling; 512-span queue, 128-span batches; one export request at a time; 1s export and shutdown limits; 5s metric exports; 128 metric attribute sets per instrument. Limits are validated. Exports are asynchronous. Saturation drops telemetry. The Collector has a memory limiter, bounded batching, a 256-request trace queue and retries limited to five seconds. Backend outages do not extend application deadlines.

Tempo uses local disposable storage and one-hour retention; Prometheus has a 24-hour/256MiB retention bound. Grafana, Tempo and Prometheus data live in container tmpfs. Stopping/removing this stack loses that telemetry. These are development access/retention assumptions, not an authenticated production telemetry deployment. Internal receivers bind inside the Compose network; only the OTLP HTTP receiver and UI/query endpoints are published to host loopback. Do not expose them publicly.

Stop/remove only this standalone stack:

```sh
docker compose -p commerce-v2-observability-local -f compose.observability.yaml --profile observability down
```

Keep application and development store volumes intact. Do not use a global Docker prune, broad volume removal, or stop unrelated projects.

## Verify and clean owned test resources

```sh
npm run typecheck
npm run test:harness
npm run test:observability
OBSERVABILITY_REPORT_DIR=/tmp/phase17-live npm run verify:observability
OBSERVABILITY_REPORT_DIR=/tmp/phase17-performance node scripts/observability-benchmark.mjs
INTEGRATION_EXECUTION=host INTEGRATION_REPEAT=2 npm run test:isolated
```

The live runner uses `commerce-v2-observability-<12 hex>` and the existing portable harness uses `commerce-v2-stabilization-<12 hex>`. They generate test env files, passwords, ports and stores; they do not use development env files or volumes. The live runner removes its secret/temp directory after verified owned cleanup and keeps sanitized evidence in the supplied report directory. Set that directory outside the runner's temporary secret directory. Only remove a failed run's exact project after checking its name and labels; never substitute a development project name.

The live proof requires responsive Docker, loopback port forwarding and enough free resources for both owned stacks. A dedicated Ubuntu runner is preferable; the historical Phase 16 runner's Linux/14GiB planning floor is unchanged. The prepared Phase 17 workflow is manual-dispatch only and has not been pushed or executed. This runbook does not authorize a commit, push, workflow registration, or remote run.
