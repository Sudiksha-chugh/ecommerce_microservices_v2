# Phase 17.1 final verification — 15 October 2026

**PHASE 17.1 STATUS: COMPLETE for the verified source below.**

[Successful Ubuntu 24.04 run 38705147319](https://github.com/Sudiksha-chugh/ecommerce_microservices_v2/actions/runs/38705147319). Node 24.21.0; all ordered gates passed. This report supersedes the incomplete status of the earlier local/remote attempts without replacing their evidence. Detailed retained results: [phase-17-final-verification-results.json](phase-17-final-verification-results.json).

## 1. Starting repository state

Original branch `backend`, HEAD `e501bc4b9a6ba1e346aa64d9d43da1609c5f455c`, extensive pre-existing unstaged/untracked work and empty staged index. Starting status/diffs/untracked inventory and 407 file hashes were captured before Phase 17.1 edits. Original backend HEAD/index remain unchanged. Final reports remain local and uncommitted.

## 2. Phase 16 baseline comparison and exact verified source

Phase 16 reference `f5a3e805424f0cdbb56112fecd95b4bf7906151f`: all 315 hashes matched the pre-Phase-17 inventory. At Phase 17.1 start, 246 still matched and 69 had expected Phase 17 edits; no verified source path was missing and no unexplained baseline mismatch was found. The older backend commit differed at 224 paths including the manifest; that did not mean its working tree lacked the fixes.

Classification A: expected Phase 17 observability additions/edits. B: accounted-for pre-existing Phase 1–16 implementation in the working tree on an older backend commit. C: all three reviewed Phase 16 fixes absent from old HEAD were already present in its working tree (workflow context placement, Lua packaging, deterministic cursor mutation). D: no newly identified unrelated change. E: no unknown starting source mismatch; historical dependency failure causes remain unknown where evidence was insufficient. No copying/cherry-picking/reconciliation into unrelated work occurred.

**Verified source:** branch `verification/phase17-stabilization`, commit `e4ed6215c19f57705744a807a995eb85f44c0723`, manifest identity `9bcf86421b72dd5eea2111940d0d77d92081500b7d6251060f9a55017310841b`, 416 reviewed source/config/test/documentation files plus manifest. Commit and every source hash were checked before and after gates. Original Phase 16 workflow, builder, manifest and reports remain preserved. Final local documentation added after CI is not claimed to be part of the tested commit.

## 3. Exact historical failed tests

[Historical failure matrix](phase-17-regression-failure-matrix.json) preserves all 19 failed executions and all 28 setup-blocked case names, assertions, available stacks, first captured operations, dependencies, OTEL evidence and reproduction limits. First attempt: 957/970 passed, 13 failed. Second: 936/970 passed, six failed and 28 unexecuted. Both historical attempts used source that changed during execution. Their results do not certify final source.

[Remote investigation report](phase-17-remote-verification-report.md) and its linked results preserve the three later failed verification runs and separately authorized corrections. The final two complete runs include the affected current test cases and do not reproduce their failures; individual isolated historical reproduction trials were not substituted for the complete runs.

## 4. Failure classifications

Historical failures included PostgreSQL pool/setup timeouts, uncertain persistence failure, broker connect/recovery deadlines, Elasticsearch/reset/checkpoint deadlines, and Redis recovery/latency assertion failures. Their exact operation-level symptoms are retained; missing historical diagnostics are explicitly marked unknown. A prior Redis option-client wrapper correction was already present and passed fresh tests. Mutable-source execution and missing diagnostic evidence were verification defects. Subsequent immutable Linux evidence identified the route-label and restart-plumbing defects described below.

## 5. Confirmed root causes and corrections

- Gateway Express route arrays were joined into a union such as `/checkout|/checkout/:orderId/retry`. All five proofs failed at the `/checkout` log lookup. A new HTTP test reproduced this before the fix. Middleware now selects the matched registered template using Express's existing `path-to-regexp` 8.4.2 matcher, declared directly; concrete path IDs are never labels. No business request/transaction semantics changed.
- Failure reports were not projected into retained artifacts. Sanitized, bounded summaries now retain failed/unexecuted names, assertions, stack frames and setup messages, with explicit truncation markers and credential/JWT redaction.
- Docker stop/start reassigns ephemeral published ports. A tiny owned diagnostic reproduced a changed ephemeral port and a stable explicit port. The live runner now reserves explicit loopback ports and checks endpoint stability.
- Tempo/Prometheus/Grafana tmpfs data is intentionally disposable and was erased by outage tests. A tiny owned marker diagnostic confirmed this. Grafana trace/query validation now occurs while the normal proof data exists, before destructive outages; readiness/datasources/dashboards are checked again after restart.
- Proof cleanup now attempts all owned disposals and backend restoration even when an earlier disposal fails.

All original five proof names and existing assertions were preserved. No failure was skipped, suppressed or made to pass by extending production deadlines or changing payment, inventory, saga, idempotency or ACK/NACK behavior.

## 6. Unknown causes and evidence limits

The four historical local readiness failures and original nonfinal-source dependency failures cannot be causally reconstructed from their incomplete diagnostics. Current Linux success establishes non-reproduction on final source, not a retrospective host-pressure diagnosis. The omitted assertion report from the first remote attempt cannot be recovered from its expired hosted machine. Those uncertainties remain documented and are not represented as solved production defects.

## 7. Files changed

Original source review: [phase-17-source-review.json](phase-17-source-review.json). Separately approved verification commits: initial snapshot `ae2b18f`, diagnostic retention `be9c087`, route correction `55a330a`, restart verification `e4ed621`. The final correction contains seven paths: live runner, readiness helper, restart harness tests, existing proof file, Grafana proof helper/declaration and manifest. The production correction was restricted to matched HTTP route labels and the existing matcher dependency declaration/lock reference. Other stabilization changes are tests/tooling/documentation. No unrelated work was reset or overwritten.

## 8. Observability-disabled verification

**PASS:** 228/228 focused checks on the final Linux source, zero failures/pending/failed suites. They include Gateway forwarding/readiness/security, Search unit behavior, rate-limit decisions and Messaging contract/lifecycle checks. The 33/33 observability cases include a fresh disabled-process test proving no SDK/exporter imports, original PostgreSQL/Redis object identities, original fetch arguments/response/errors, unchanged message metadata and request IDs, and middleware pass-through. The complete store regression then passes twice with default-disabled application instrumentation; observability tests enable their own isolated SDK deliberately.

## 9. Infrastructure readiness

**PASS:** dedicated four-CPU Ubuntu host, approximately 15.6 GiB RAM/Docker memory, 14.3 GiB available RAM, zero swap used, approximately 84.9 GiB free disk and no initial running containers. Functional store startup/provisioning and Elasticsearch preflight passed. Collector OTLP readiness, Tempo readiness, Prometheus API, Grafana health, both datasource health checks, authentication and seven dashboards passed. After real outage stop/start, endpoints remained stable and all backend/datasource/dashboard readiness checks passed again. Running state alone was never treated as readiness.

## 10. Collector ingestion

**PASS:** actual application spans and application metrics traversed the pinned Collector, then were retrieved from Tempo and Prometheus. An empty OTLP receiver probe is recorded separately and is not the ingestion proof. The final performance mode C uses the actual supplied Collector endpoint after recovery.

## 11. Tempo trace retrieval and parentage

**PASS:** checkout trace `c32f02eac26e6faba70a294ce104ff08`, Search trace `b33ea3e1f154c8800d6de29e9f8caec7`, Redis trace `7c3b3ee75016ebf9a8839509f6f7961c`. Service resource: `observability-proof`. The actual retrieved checkout topology includes:

- Gateway `HTTP POST` span `62ed826dd4e9b35d`, root.
- HTTP client `http POST` span `92167ba839b7b495`, parent `62ed826dd4e9b35d`.
- Orders `HTTP POST` span `4df493ccc4fa1561`, parent `92167ba839b7b495`.

The retained topology also contains actual producer→consumer parent IDs, PostgreSQL children, plus separately retrieved Redis PING and Search/Elasticsearch spans. Proof assertions reject partial traces even if expected names occur, and reject sensitive exported attributes. Request/log correlation is checked without exporting request/user/product IDs as metric labels.

## 12. Prometheus application metrics

**PASS:** application HTTP requests/errors and latency, client latency, messaging operations, business observations and dependency durations were retrieved. Retained series counts respectively: 7, 1, 7, 3, 6, 7 and 13. Tests require positive counter/histogram count values, `service_name=observability-proof`, at most 128 series per queried instrument and no identity label keys. These are application metrics, not Collector self-metrics.

## 13. Grafana live verification

**PASS:** authentication returns 401 without credentials; two provisioned datasources are healthy; seven dashboards are provisioned. All **15 actual provisioned PromQL queries** executed and returned nonempty application series. Grafana's Tempo proxy retrieved the actual checkout trace. Queries/navigation were verified before outage tests erased their tmpfs data; authentication/provisioning/readiness was also checked after restart. No exemplar was fabricated or claimed. Verification is through the actual Grafana APIs, not a browser visual/layout audit.

## 14. Five end-to-end proofs

**5/5 PASS**, zero skipped/unexecuted, zero failed suites:

1. `retrieves the actual Gateway checkout/RabbitMQ and Search dependency traces and metrics`
2. `preserves committed checkout, one charge, inventory and ACKs during otel-collector outage`
3. `preserves committed checkout, one charge, inventory and ACKs during tempo outage`
4. `preserves committed checkout, one charge, inventory and ACKs during prometheus outage`
5. `preserves committed checkout, one charge, inventory and ACKs during grafana outage`

This exercises actual HTTP, AMQP, PostgreSQL, Redis, Elasticsearch and telemetry backends using existing component implementations. The proof's SDK resource is one process, `observability-proof`; this is not a nine-process deployment/load certification. All nine service bootstrap paths remain instrumented, with preload/type/runtime checks and complete service/package regression.

## 15. RabbitMQ safety

**PASS:** real-broker full regressions and five business proofs cover publisher confirms, manual disposition, retry/DLQ, duplicate delivery and inbox/outbox/idempotency behavior. Each outage flow retains one charge and committed inventory; injected committed-before-ACK failure retries safely and wrong-signature poison delivery reaches DLQ. Controlled-AMQP tests independently verify confirm-before-completion, handoff-before-ACK, no ACK on failed handoff, preserved event/correlation/request IDs and headers, valid/malformed/missing trace metadata, and failed exporters not changing consumer outcomes. Existing contracts and lifecycle cases remain intact.

## 16. Failure isolation

**PASS:** real Collector/Tempo/Prometheus/Grafana outages preserve business outcomes and ACK assertions. Backend restarts recover functionally on stable endpoints. Fresh-process runtime tests cover unavailable exporter, OTLP timeout, queue saturation and bounded shutdown during export; normal business errors retain identity. Shutdown/export bounds and production request deadlines were not increased. Temporary telemetry data loss on explicit backend stop/start is expected for this disposable profile and is not misreported as durable storage behavior.

## 17. Performance investigation

Nine sequential fresh processes in rotated `ABC / BCA / CAB` order; each has 500 warmup requests, 20,000 measured requests at concurrency five and 1,000 awaited operation fixtures. Three runs per mode; zero HTTP/warmup errors across all 180,000 measured requests. Sampling is 10% for enabled modes. Per-run warmup/measurement duration, initialization, process CPU, sampled RSS/heap, p50/p95/p99, throughput and error counts are retained in the results JSON.

Median results:

- **A, disabled:** p50 0.600 ms, p95 1.403 ms, p99 2.419 ms; 6,740 requests/s; 0.2214 CPU ms/request; sampled RSS 311.5 MiB; measurement 2.968 s; initialization 128.0 ms.
- **B, SDK with in-process no-op exporters:** p50 0.936 ms, p95 1.833 ms, p99 3.309 ms; 4,730 requests/s; 0.2930 CPU ms/request; RSS 325.0 MiB; measurement 4.228 s; initialization 221.7 ms. Queue/batch/metric-reader machinery remains; telemetry network is absent.
- **C, actual OTLP to live Collector:** p50 0.976 ms, p95 1.957 ms, p99 3.629 ms; 4,440 requests/s; 0.3061 CPU ms/request; RSS 329.5 MiB; measurement 4.504 s; initialization 222.0 ms.

C versus A: p95 **+39.5%** (+0.554 ms), throughput **−34.1%**. B versus A accounts for +30.7% p95/−29.8% throughput; C versus B adds +6.7% p95/−6.1% throughput. Most combined cost is present before telemetry network exporting, but this does not isolate context, manual span creation, metrics, structured-log formatting or queues individually. Automatic instrumentation is absent. Initialization is measured separately and excluded from steady HTTP timing. Event fixtures are not a real RabbitMQ throughput test. Process CPU percentages may exceed 100% of one core; they do not measure Collector CPU. The runner's initial Docker host was empty; during measurements only the intentional telemetry backend load remained.

**Material overhead remains and is documented, not declared negligible or production-approved.** No performance threshold was invented after seeing results. Bounded next optimizations: profile completion-log serialization, context/span creation and metric recording separately; test lazy/disabled-path allocation removal and repeated label-object caching only where a profile demonstrates cost; preserve sampling, privacy/cardinality/queue/shutdown bounds and rerun the same correctness/workload gates for any future optimization. No such extra optimization or Phase 18 work was started.

The benchmark's `localReceiverTotals`/`exportsDuringHttp` counters instrument its optional local acknowledging fixture only. With an external Collector they are **unobserved**, not actual zero exports or measured Collector counts. Real application ingestion is separately established by the live proof. This microbenchmark does not establish production capacity or exact production overhead.

## 18. Final complete regression

**981/981 PASS twice**, same final commit/manifest, independently provisioned stores. Each run has zero failed cases, zero pending/unexecuted cases and zero failed setup/teardown suites. All default service/package test files are included without a name filter; the count is discovered, not assumed to remain 948. The 33 new observability cases explain the increase from Phase 16's 948 baseline. Both runs include Messaging, Search, Gateway, shared utilities and all existing service workflows. Additional separate gates: 47/47 harness, 33/33 observability, 228/228 disabled-focused and 5/5 live proof tests; these counts overlap where explicitly rerun and are not summed into an inflated total.

## 19. Unexecuted tests

**Zero unexecuted/skipped cases in the final required gates.** The 28 historical setup-blocked checkout cases are preserved as historical failures and covered by current complete runs. Historical isolated reproduction experiments that were not performed are not counted as tests passed. Production-scale performance, a nine-process deployment smoke test and browser visual QA are outside the bounded existing proof/run scope and are not claimed.

## 20. Resource cleanup

Owned telemetry project `commerce-v2-observability-c94ddd54b4e3` reports cleanup verified. Three distinct store projects report cleanup:

- Proof stores: `commerce-v2-stabilization-ec3901b8a4c8`.
- Full run 1: `commerce-v2-stabilization-5a2486f840ed`.
- Full run 2: `commerce-v2-stabilization-bbe31f6a7d02`.

Diagnostics record zero probe-query failures in each project. Local tiny restart/reservation diagnostics closed/removed only their owned resources. No global daemon restart, pruning, unrelated container stop or development-volume removal occurred.

## 21. Development data and source preservation

No development PostgreSQL/Redis/RabbitMQ/Elasticsearch data command was issued. All 407 starting files remain; the original index and backend HEAD are unchanged; 24 protected environment/history files remain hash-identical. Actual environment files, secret/key directories, development data and raw diagnostics were excluded from source transfer. Generated test credentials and private raw logs remain outside the public artifact projection. Existing application changes were not reset/cleaned or overwritten.

## 22. Git and authorization

Each verification branch/commit/public push and each of the four standard-runner dispatches received separate explicit approval. Main received only the separately approved workflow-registration commit `b1a50729f1a5303a8ebac6d01006797085afbcbd`; no application change, merge or force push. No paid/larger runner was provisioned. No additional run is pending. Final local report updates are intentionally uncommitted; no extra commit/push is implied by completion.

## 23. Remaining limitations

No outstanding correctness/verification gate failure remains for this source. Historical causes without retained evidence remain unknown, and benchmark overhead is material. Verification is the existing component proof plus complete regression on a standard Linux runner; it is not a production rollout, capacity certification or durable telemetry-storage guarantee. These limits are explicit and do not substitute for any failed/skipped required test.

## 24. Final decision

**Phase 17 is fully verified within the requested Phase 17.1 scope for commit `e4ed6215c19f57705744a807a995eb85f44c0723`.** All final required gates pass with zero failed/skipped/unexecuted cases and successful owned cleanup. Development data and original changes/history are preserved. Phase 18 was not started. Stop after Phase 17.1.

## Phase 18 handoff

The statements above record the completed Phase 17.1 verification before this documentation-only handoff. The subsequent user instruction authorizes finalizing these reports and starting `phase18/sql-telemetry` from this documented descendant of `e4ed621`. The Phase 17 manifest continues to identify the tested source, not later documentation or Phase 18 changes.
