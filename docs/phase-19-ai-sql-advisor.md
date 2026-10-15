# Phase 19: AI-powered SQL optimization advisor

AI recommendations are advisory and must be validated against representative workloads before production adoption.

## Architecture and data flow

The advisor extends `@ecommerce/observability`, the owner of Phase 18 SQL diagnostics. It introduces no service, database client, migration, query instrumentation, fingerprinting, or plan parser. `sql-advisor.ts` consumes Phase 18 telemetry digests and `SqlDiagnostics.explain()` results. It builds bounded allowlisted snapshots, deterministic recommendations and priorities before optional provider enrichment. The result passes a strict runtime schema and provenance comparison before being returned through authenticated read-only reporting.

There are deliberately two evidence contexts:

- Existing service-local `/internal/sql/advisor/*` reports analyze that process's sampled telemetry. They are deterministic only, do not accept a provider key, and exist only wherever Phase 18 reporting is mounted. Preserve the existing private network/access policy for these internal reporting endpoints.
- The separate Phase 18 loopback listener exposes `/internal/sql-advisor/*`. It can enrich approved template plans with optional AI. Its process-local telemetry store normally has no business samples, so its telemetry candidates are normally empty. It does not fetch business reports or extract production data.

There is no verified mapping from approved generic EXPLAIN templates to observed workload fingerprints. Template analyses use a separate digest namespace derived from the approved query ID, with no workload count or latency. They must not be interpreted as workload-correlated plans. No remote telemetry ingestion endpoint was added.

## Provider abstraction and configuration

`SqlAdvisorProvider` receives only a validated `AdvisorSnapshot`, a deterministic baseline and an abort signal. `OfflineAdvisorProvider` returns the baseline without HTTP. `OpenAiAdvisorProvider` uses native fetch to the fixed HTTPS Responses API endpoint, with strict JSON schema output, `store:false`, no tools, no redirects and no retries. Its HTTP client can be injected for deterministic testing. See [official structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). Model/account availability is operator-managed. No live provider calls are made in tests.

Ordinary business startup requires no AI configuration or key. AI is disabled by default. Copy the reviewed values from `.env.sql-advisor.example` into the environment of the separate diagnostics process. The Phase 18 runbook describes the required dedicated read-only database role, local database tunnel, credential file, JWT issuer/audience/public key and loopback port. No role provisioning or grants occur automatically.

Run `npm run sql:diagnostics` under Node 24. This preloads the existing Phase 17 observability bootstrap. To export advisor metrics, enable OTEL with the existing resource and collector configuration. The listener remains disabled unless `SQL_DIAGNOSTICS_ENABLED=true`. Do not publish or proxy its loopback port publicly.

Configuration defaults and hard bounds:

- `SQL_ADVISOR_AI_ENABLED=false`. Only the exact value `true` enables enrichment.
- `SQL_ADVISOR_PROVIDER`: explicitly `offline` or `openai` when enabled. There is no provider fallback.
- `SQL_ADVISOR_MODEL`: required explicit model identifier for OpenAI, at most 100 safe characters. Use a model supporting the configured structured output contract.
- `SQL_ADVISOR_API_KEY`: required only for OpenAI. Inject securely at runtime. Never log or commit it.
- `SQL_ADVISOR_TIMEOUT_MS=3000`, maximum 10000.
- `SQL_ADVISOR_MAX_CONCURRENT=2`, maximum 4.
- `SQL_ADVISOR_MAX_OUTPUT_TOKENS=2000`, maximum 4000.
- `SQL_ADVISOR_REQUESTS_PER_MINUTE=10`, maximum 60.
- `SQL_ADVISOR_TOKENS_PER_MINUTE=100000`, maximum 1000000.
- `SQL_ADVISOR_CACHE_TTL_MS=60000`, maximum 3600000.
- `SQL_ADVISOR_CACHE_ENTRIES=32`, maximum 128.

All numeric settings must be positive integers. Invalid enabled-provider configuration rejects the separate diagnostics startup with a fixed error classification, without affecting business services. In-process reports always use explicitly disabled AI settings.

## Privacy and prompt injection boundary

Provider inputs include a version, opaque fingerprint digest, allowlisted SELECT/WITH/OTHER operation, bounded sampled count and latency numbers, optional numeric root plan estimates and up to 128 deterministic plan findings. Each plan finding contains only a numeric node ID, a reviewed finding code, estimated cost and estimated rows. The baseline and reviewed literal narrative choices accompany this snapshot. No database-derived free text reaches the provider. Unknown fields and unsupported enums are rejected. The OpenAI request body, including instructions and schema, must fit 32768 UTF-8 bytes.

The provider never receives SQL text, comments, parameter values, identifiers, table/index names, conditions, raw plans, logs, row contents, database credentials, connection strings, tokens, email addresses, customer information or raw exceptions. Unavailable service/version/index metadata is omitted rather than inferred. The API key is used only in the fixed provider's Authorization header.

System instructions classify diagnostics as untrusted data, ignore embedded instructions, prohibit execution, credential requests and infrastructure changes, and require uncertainty. Security does not depend on this prompt: neither provider has tools or a database capability, the HTTP API accepts identifiers only, Phase 18 retains the database privilege boundary, and responses undergo strict schema and evidence validation. Strings containing SQL command keywords, command delimiters, URLs, credential requests and common instruction attacks are rejected. Text filtering is deliberately conservative and is not a proof of semantic truth. Accepted prose remains untrusted advice and is never executed or treated as verified evidence.

## Deterministic baseline and prioritization

Supported categories are sequential scans, elevated estimated plan cost, elevated sort cost, potentially expensive joins, access-path/index investigation, high sampled frequency, elevated p95 histogram bucket, large estimated row sets and query-shape review. Only supporting evidence enables a category. Each finding includes provenance, an explanation with uncertainty, a suggested investigation and validation against representative plans and measured workload latency.

Thresholds are transparent review heuristics: estimated cost at least 1000, estimated rows at least 10000, sampled count at least 1000, and finite p95 histogram upper bound at least 100 ms. High priority requires at least two of elevated cost, elevated sampled frequency and elevated latency. Any remaining finding yields medium priority; no findings yields low. Candidate sorting uses this priority followed by stable fingerprint ordering. These thresholds do not estimate benefit or measured improvement.

A sequential scan can be appropriate. Sort cost does not establish a memory spill. Large estimated rows do not establish actual returned result size. Cost is not runtime. Histogram bounds are not exact percentiles; overflow p95 is unknown. Counts are sampled observations within Phase 18 retention, not total workload counts or rates. Missing index metadata prevents assertions of missing indexes. Index investigations mention write/storage overhead. Request correlation is absent, so N+1 cannot be established. Generic plans lack actual row counts, so row-estimate accuracy cannot be assessed. These unsupported categories are explicitly withheld rather than invented.

## Recommendation schema and provenance

`recommendationSchema` is a strict Zod object: version 1, fingerprint digest, summary, enumerated severity/confidence, up to six priority reasons, up to sixteen findings and one to eight limitations. Each finding has an enumerated category, bounded evidence string, bounded explanation/recommendation, one to four bounded validation steps and enumerated confidence. Prose strings are at most 800 characters, evidence at most 180. Provider output is at most 24000 characters; the HTTP response envelope is streamed with a 65536-byte cap.

Enrichment must preserve fingerprint, finding count/order/types, evidence, confidence, severity, priority reasons and all limitations exactly. AI may select fuller explanations and validation language from reviewed literal narrative choices supplied with the baseline. Arbitrary generated prose is rejected at runtime, including novel factual claims that pass keyword filters. This deliberately limits language variety to preserve evidence grounding. Changed provenance, unexpected fields, malformed JSON, oversized output, executable content or unsupported claims are rejected. Models cannot manufacture categories or override deterministic priority. This restricts opaque model prioritization in favor of auditable rules.

## Read-only API contract

All three routes share the existing cryptographic JWT verifier and explicit admin role authorization. Missing/invalid credentials yield 401; other roles yield 403. Keep service-local reports behind the same internal network boundary used for Phase 18. The separate diagnostics listener binds only to 127.0.0.1 and has eight maximum connections with bounded HTTP deadlines.

Base paths are `/internal/sql/advisor` for service-local deterministic telemetry and `/internal/sql-advisor` for the separate loopback listener:

- `GET /health`: AI enablement, circuit state and bounded pending count. No keys, model payloads or exception text.
- `GET /candidates`: bounded telemetry candidate digest/operation/count/p95 summaries and approved query IDs available in this context.
- `POST /analyze`: exactly `{ "fingerprint": "q_<24 lowercase hex characters>" }` OR `{ "queryId": "catalog.product-by-id" }`. Fingerprints must already exist in that process's telemetry. Query IDs must belong to the injected Phase 18 diagnostics service. No arbitrary prompts, SQL, plans or parameters are accepted.

Analyze returns `{ recommendation, enrichment, failure? }`, with enrichment `disabled`, `success` or `failed`. The recommendation is runtime-validated before response. A failed enrichment preserves deterministic advice and includes a fixed failure enum. Unknown snapshots yield 404, malformed requests 400, unavailable EXPLAIN 503, and admission overload 429. Requests with query parameters are rejected. Bodies are limited to 1 KiB. Responses use `Cache-Control: no-store`.

Each router admits at most twenty authenticated requests per minute and two simultaneous HTTP requests across its routes. This is a bounded process-local diagnostic limit, not a distributed user quota. JWT verification precedes admission. There is no mutation endpoint, SQL execution endpoint, generated tool call, schema change, automatic index operation or provider-supplied EXPLAIN. Approved EXPLAIN remains governed by Phase 18's own database and concurrency limits.

## Cache, budgets and failure isolation

The in-memory cache key is a SHA-256 digest of advisor version, provider/model identity and the full sanitized snapshot (including fingerprint). Changes to evidence invalidate it. Expired entries are evicted, entries are capped, successful values are cloned, and concurrent identical requests share one promise. Failures are not cached and cannot poison later results. In-flight admissions and cache size are separately bounded. Cache identity deliberately contains no SQL or secrets. Increment the advisor version for changes to recommendation policy/schema.

Every attempt reserves its complete output token allocation plus 32768 tokens for the bounded UTF-8 input body, conservatively treating every input byte as a token. This is a local conservative budget, not an invoice estimate. The default token budget permits fewer calls than the request budget when needed. Both budgets use a rolling minute. Cache hits and identical in-flight requests do not reserve more budget. There are no retries.

Timeout aborts the HTTP operation. A custom provider ignoring cancellation retains a physical concurrency slot until it settles, preventing unlimited orphaned calls. After three failures, the circuit opens for thirty seconds; recovery occurs on a subsequent allowed request. Timeout, unavailable, invalid_response, busy, budget and circuit_open are explicit classifications. Disabled AI immediately returns baseline advice without a provider call.

Only read-only diagnostics invoke the advisor. Checkout, authentication, orders, payments, inventory and messaging do not await AI. Existing telemetry continues independently. Observability operations use Phase 17's failure-isolated helper and metric writes are guarded. No exceptions, prompts or model responses are logged. Fixed structured enrichment failure logs include only component, outcome and reason.

## Observability

The existing OTEL meter exports `sql_advisor_requests_total`, `sql_advisor_analysis_duration_seconds`, `sql_advisor_provider_errors_total`, `sql_advisor_validation_failures_total`, `sql_advisor_fallback_total` and `sql_advisor_inflight_requests`. Only fixed failure reasons are metric labels; SQL, digests, user IDs, model text and exceptions are excluded. The in-flight metric measures admitted analysis until completion/timeout; a timed-out uncooperative provider can still hold an internal physical capacity slot. `sql-advisor.analyze` spans contain no prompts, output or diagnostic identifiers. A new panel is appended to the existing SQL dashboard without modifying its prior panels.

## Testing and operations

Use Node 24 and the existing lockfile (`npm ci --ignore-scripts`). No lint script is configured. Run:

```
npm run typecheck
npm run test:sql-advisor
npm run test:sql
npm run test:observability
npm run test:sql:integration
npm run test:isolated
```

The isolated runners create random owned Docker fixtures, verify fixture identity and remove only their own resources. Never point integration tests at development or production databases. Provider tests inject fakes, including an injected HTTP client for the real API contract; CI does not call external LLMs. Privacy tests inspect exported metrics, spans and logs. The PostgreSQL advisor test verifies unchanged rows after malicious model output. See `phase-19-verification-report.md` for exact commands, results and limitations of this implementation run.

Operational limitations: caches, quotas and circuits are local to a process; restarting resets them. Human reviewers must validate all prose and recommendations. The optional real provider is contract-tested without an account-backed live call. Empty telemetry candidates in a standalone listener are expected. There is no automatic cross-service workload/plan correlation, index inventory, actual execution analysis, N+1 detector or tuning automation. Those require separately reviewed evidence collection, not an AI guess.
