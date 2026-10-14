# Phase 17.1 stabilization report

Status: **INCOMPLETE**. No Phase 18 work. This report records local work and prepares a dedicated verification path; it does not certify the live stack or full regression.

## 1. Starting repository state

Branch `backend`, HEAD `e501bc4b9a6ba1e346aa64d9d43da1609c5f455c`, with extensive existing unstaged and untracked work. The starting index was empty and has not been changed. Captured status, tracked/cached statistics, untracked paths and SHA256 preservation inventory before edits. Private evidence: `/private/tmp/commerce-v2-phase17-1`. Inventory contains 407 starting files, including ignored actual environment files; their contents are not copied into this report or source snapshot.

## 2. Phase 16 baseline comparison

Verified reference: `f5a3e805424f0cdbb56112fecd95b4bf7906151f`, manifest identity `e4c195627c715fcad9244f445e5e4ea6e9501dd0399e24c5dfbf23f5cc1a59c1`. Its 315 source-file hashes all matched the saved pre-Phase-17 inventory. At Phase 17.1 start, 246 still matched, and 69 differed through expected Phase 17 edits. No verified path was missing; no mismatch existed between the pre-Phase-17 inventory and the verified manifest. Backend HEAD versus the verified commit has 224 changed paths, including the manifest: old HEAD is not the current working-tree baseline.

Classification:

- **A — Expected Phase 17:** SDK package, service bootstrap/HTTP/dependency/messaging observations, lockfile, opt-in Compose stack, provisioning, tests, workflow and documentation. Phase 17.1 additions are verification tooling and tests, listed in the source review.
- **B — Pre-existing backend differences:** Phase 1–16 source/configuration existed as uncommitted work on the older backend HEAD. It is accounted for by the verified manifest and prior preservation inventory; no automatic branch reconciliation was performed.
- **C — Verified fixes absent:** all three reviewed fixes are absent from old backend HEAD but **present in the working tree**: step-scoped `runner.temp`, Lua asset packaging with archive/runtime coverage, and guaranteed cursor tampering with deterministic A/B-prefix fixtures. None needs copying.
- **D — Unrelated local changes:** none newly identified relative to the saved Phase 17 inventory. Existing files outside the source allowlist remain in place.
- **E — Unknown:** no unexplained starting source-baseline mismatch. Historical failure causes remain unknown where noted below.

The Phase 16 integration runner, startup observers, verification harness, integration Compose configurations, test discovery configuration and original cursor fixture remain unchanged by Phase 17.1. Phase 17 added OTEL defaults to development Compose and a separate optional stack. The lockfile differs from Phase 16 for the reviewed Phase 17 SDK dependencies; Phase 17.1 does not change it. Default discovery still covers all service/package `*.test.ts`; five `*.proof.ts` cases use a separate configuration. The historical runs contained 948 baseline + 22 then-existing observability tests = 970; the completed Phase 17 source had 23 observability tests. Current expanded discovery is recorded in section 18.

## 3. Exact historical failed tests

Both original JSON reports and all four readiness logs were inspected and preserved. [The failure matrix](phase-17-regression-failure-matrix.json) contains **all 19 failed executions and all 28 unexecuted case names**, exact errors, full available stack frames, expected/actual behavior, first captured failing operation, dependency, OTEL evidence, isolated/disabled/baseline reproducibility and cause classification.

Attempt 1: 957/970 passed, 13 failed, zero pending, 14 failed nested suites. Seven files failed: checkout, refund/compensation, observability unit, Messaging, Search integration, Redis rate-limiting integration. Attempt 2: 936/970 passed, six failed, 28 unexecuted, ten failed nested suites. Checkout setup failed before its 28 tests; four other files had test failures. Nested suite counts are not separate worker deaths.

## 4. Failure classifications

- PostgreSQL pool connection timeouts: checkout setup/body and refund reset hooks. First reported frames are in `pg-pool`, checkout line 74 or refund line 71. The second checkout suite message is a setup error, not 28 successful/skipped-by-design tests.
- Inventory compensation: `InboxProcessor.process` returned uncertain persistence failure. The underlying PostgreSQL exception was not serialized; transaction outcome cannot be inferred from this report.
- RabbitMQ: amqplib connect `ETIMEDOUT` in attempt 1; broker-link interruption and distributed refund tests hit existing 30-second deadlines in attempt 2. Exact in-flight operations at those test deadlines were not captured.
- Search: Elasticsearch requests failed, two reset hooks exceeded 15 seconds, and two crash-checkpoint waits exceeded their existing deadlines. The report identifies reset versus test-body frames; SIGKILL was an intended crash fixture, not evidence of a Vitest worker dying.
- Redis: recovery returned 503 instead of 200; concurrent recovery produced zero of four expected successes; slow-command elapsed 660.219 ms exceeded the existing 500 ms assertion. The zero-success failure repeated in both attempts; response distribution was not retained.
- Observability Redis-option-client unit: the original missing wrapper was corrected during Phase 17. Fresh current tests pass. A stale transformed module during the mutable first run is plausible, but no cached-module identity was retained, so that particular mechanism is not proven.

Historical non-observability suites used default-disabled bootstrap semantics, but neither old report records an explicit OTEL environment snapshot. Observability unit hooks enabled the SDK explicitly. No baseline assertion, hook budget, production deadline or test was weakened.

## 5. Confirmed findings

Neither historical regression ran against an immutable final source: source edits occurred during execution, and the final HTTP parentage case was added later. Their 970-test reports therefore cannot certify the current tree. The prior snapshot allowlist excludes `.d.mts` declarations and `vitest.observability.config.mjs`; reusing it for Phase 17 would omit required verification/type files. The old readiness report loses the precise failing operation and timing. The old benchmark has only two modes and an unreachable exporter. Proof cleanup previously stopped at its first cleanup error, potentially bypassing the backend restart. Name-only trace checks could accept incomplete parentage. These are demonstrated verification defects, not proven payment/inventory/transaction defects.

## 6. Unknown causes

The historical dependency failures have not been independently reproduced on an immutable final source or the Linux baseline. Their underlying causes remain unknown. Current host contention does not retrospectively prove causality. No report establishes an OOM kill, worker termination, teardown defect or exporter-caused business failure. Historical reports do not include complete per-operation diagnostic streams; those missing facts cannot be reconstructed after owned containers were removed.

## 7. Corrections made

No application production source or business semantics changed in Phase 17.1. Changes are limited to verification tooling, the draft workflow, proof assertions/cleanup, focused tests and new documentation:

- Separate Phase 17 source builder includes declarations, proof configuration and reviewed documentation; excludes actual environments/secrets/data; verifies every hash and rejects unexpected source additions. The original Phase 16 builder and manifest are preserved.
- Dedicated runner validates approved commit and source identity before and after every gate; uses independent fresh-store full runs, stops on failure, checks report hooks/pending counts and keeps original backend untouched.
- Named readiness checks retain elapsed time, attempts, underlying error code, endpoint map, owned container state/health/OOM/restarts/limits and bounded resource sample before cleanup.
- Existing five proof names and original assertions are preserved. Additional checks require connected HTTP and Rabbit span parent IDs, the expected service resource, positive application metric values and bounded non-identity labels. Cleanup attempts every owned disposal and restart after an earlier cleanup failure.
- Live runner checks authentication, actual trace retrieval through Grafana's Tempo proxy and nonempty dashboard query results; records a Collector OTLP HTTP acceptance probe separately from actual trace ingestion.
- A/B/C performance measurement uses rotated order, fresh processes, explicit warmup/measurement durations, CPU per request, memory, errors and export counts. B disables telemetry network through in-process no-op exporters while retaining SDK queues/readers; C uses a supplied Collector when run inside the live runner.

## 8. Disabled-mode verification

Focused disabled-mode checks pass. A fresh-process loader rejects any SDK/exporter import and verifies no such import occurs, original PostgreSQL/Redis object identity, original fetch arguments/response, original errors, unchanged message headers and request ID, and direct middleware pass-through. Existing Gateway forwarding/readiness/security tests, all Search unit tests, Redis decision tests, Messaging contract/lifecycle tests and observability tests were run without development stores. Exact final counts appear in the results JSON.

This is partial verification: real database transactions, Redis recovery, Elasticsearch behavior and broker/outbox/inbox guarantees still require the dedicated integration runs. No exporter/backend dependency was required for the disabled fixture. Existing baseline test files were not modified.

## 9. Infrastructure readiness

[Readiness forensics](phase-17-readiness-forensics.json) records the four historical projects, timestamps, errors and relevant retained log lines. All failed before the business-store/proof child was launched; each reported owned cleanup successful. The first three report `fetch failed` (two with `UND_ERR_SOCKET`); the fourth reports an aborted request timeout. Exact per-operation elapsed times, container health and resource samples were not retained and are explicitly unknown.

Prometheus reported readiness in earlier logs, but that does not prove all backends ready. The fourth Tempo log shows slow startup followed by repeated **internal `127.0.0.1:9095` frontend dial timeouts**. This establishes Tempo query-path failure symptoms; it does not distinguish host scheduling, transport or Tempo configuration as the root cause. Grafana's secret-read/startup line alone proves neither a permission error nor readiness. Earlier secret-mode/Collector-limit changes are not presented as proven fixes.

Fresh capacity check: host RAM 16 GiB, swap used 11,571.88 MiB, Docker memory 8,319,504,384 bytes (7.75 GiB), 34 pre-existing running containers, approximately 46 GiB free disk. Docker info/ps/stats responded within the bounded diagnostic call. Resource sampling included an existing RabbitMQ at 68% CPU; this is a point sample, not a causal diagnosis. No unrelated resource was stopped. This environment is unsuitable for another reliable full-store verification attempt; no fifth stack attempt or local full regression was started.

## 10. Collector ingestion

**UNEXECUTED** through the actual Collector. Prior final pinned-Collector configuration validation passed and is retained in the Phase 17 report; configuration is unchanged. A successful empty OTLP receiver probe in the future is only receiver readiness, not proof of a trace. Local benchmark C exercised actual OTLP serialization/HTTP to an acknowledging fixture, not Collector ingestion.

## 11. Tempo retrieval

**UNEXECUTED**. The existing `/api/traces/<traceID>` proof is preserved and strengthened to validate actual parent IDs, accepting OTLP hex or Tempo JSON base64 identifiers. Parser tests reject partial traces with all expected names but wrong parentage. Reference: [Grafana Tempo HTTP span/query examples](https://grafana.com/docs/tempo/latest/api_docs/pushing-spans-with-http/). No fabricated trace ID or successful live result is reported.

## 12. Prometheus retrieval

**UNEXECUTED**. Existing application instrument queries are retained; added assertions require `service_name=observability-proof`, positive finite values, bounded series and absence of identity label keys. Dashboard queries must return application series, not merely successful empty responses. The proof uses real Gateway/Orders/Rabbit/SQL/Redis/Search components in one SDK process with resource `observability-proof`; it is not a nine-process deployment proof. No Collector self-metric is counted as application evidence.

## 13. Grafana live verification

**UNEXECUTED**. Seven dashboard JSONs and datasource configurations retain their historical static validation result. Prepared live checks require 401 without authentication, both healthy provisioned datasources, seven dashboards, nonempty PromQL results and retrieval of the actual checkout trace through Grafana's Tempo proxy. Configured trace-to-metrics/exemplar capabilities are not claimed as interactively proven; no exemplars are invented. Reference: [Grafana Tempo datasource documentation](https://grafana.com/docs/grafana/latest/datasources/tempo/).

## 14. Five proof results

Expanded runtime collection confirms these exact five cases, with no hook or test execution:

1. `retrieves the actual Gateway checkout/RabbitMQ and Search dependency traces and metrics`
2. `preserves committed checkout, one charge, inventory and ACKs during otel-collector outage`
3. `preserves committed checkout, one charge, inventory and ACKs during tempo outage`
4. `preserves committed checkout, one charge, inventory and ACKs during prometheus outage`
5. `preserves committed checkout, one charge, inventory and ACKs during grafana outage`

Result: **0/5 passed, 0 executed, 5 blocked/unexecuted**. These were not replaced with unit tests. Dedicated execution rejects skipped cases or any count other than five.

## 15. RabbitMQ safety verification

Five new controlled-AMQP tests use the actual Messaging implementation with an independently controlled transport. They pass for valid/malformed/missing trace metadata, unchanged payload/event/correlation/request IDs, existing headers, publisher confirm gating, confirmed retry before ACK, no ACK/NACK on failed handoff, and failed exporters without changing processing outcome. Existing disabled Messaging contract, raw-scenario, readiness and shutdown tests also pass.

This does not replace real RabbitMQ publisher-link recovery, DLQ routing, duplicate delivery, inbox/outbox persistence or business idempotency proof. Those remain blocked. Existing five business proof cases still require one charge, committed inventory, deduplication, retry, DLQ and ACK assertions.

## 16. Failure isolation

Fresh-process runtime tests pass for unavailable exporter, timeout, bounded queue saturation and shutdown during export. Controlled-AMQP tests add failed-exporter behavior with actual message handling. Collector restart and actual Collector/Tempo/Prometheus/Grafana outages during committed checkout remain **UNEXECUTED**. Generic microbenchmark or mocked transport success is not counted as a successful order/payment/inventory outage proof.

## 17. Performance measurements

Three repetitions in rotated `ABC / BCA / CAB` order; nine sequential fresh processes. Every run: 500 warmup requests, 20,000 measured HTTP requests, concurrency five, 1,000 awaited operation fixtures, 10% sampling when enabled, zero HTTP/warmup errors. Full per-run warmup/measurement durations, process user/system CPU, sampled RSS/heap and export counts are in [results JSON](phase-17-stabilization-results.json).

Median A (disabled): p50 0.742 ms, p95 2.676 ms, p99 5.108 ms; 4,530 requests/s; 0.2315 CPU ms/request; sampled RSS 276.6 MiB. Median B (SDK with no-op in-process exporters): p50 0.983 ms, p95 2.503 ms, p99 5.738 ms; 4,064 requests/s; 0.2772 CPU ms/request; RSS 275.5 MiB. Median C (actual OTLP to local acknowledging fixture): p50 1.069 ms, p95 3.462 ms, p99 7.592 ms; 3,400 requests/s; 0.3152 CPU ms/request; RSS 281.2 MiB.

B p95 spans **2.316–6.306 ms**, C **3.404–4.107 ms** and A **1.965–2.871 ms**. C transmitted 15–16 trace requests and 5–7 metric requests during each measurement. The local receiver shares the process, so C CPU includes its acknowledgement work. No live Collector measurements were obtained. Initialization is timed separately and excluded from HTTP timing. B retains span batching and periodic metrics while removing telemetry network; it is not a no-context/no-metrics control. There is no automatic instrumentation in this implementation; A→B combines manual spans, context, metrics, queues and structured completion-log formatting. B→C combines serialization, HTTP transport and the receiver. Other existing host workloads could not be controlled without disturbing unrelated work.

These measurements demonstrate variability and measurable diagnostic cost, not production overhead or an acceptance threshold. First obtain repeated isolated Linux results against the live Collector, then profile manual spans/context, metric recording and completion-log formatting separately. Keep queue/cardinality/shutdown bounds and preserve sampling semantics; optimize only a demonstrated hotspot. No correctness was disabled to improve results.

## 18. Full regression results

Final Node 24 typecheck, syntax, compiled preload, focused tests and harness results are recorded in the results JSON. Expanded discovery executes module collection only against disposable synthetic environment files pointing at closed port 1; it does not run hooks or contact development stores. It finds **980 current default regression tests in 39 files** (948 historical baseline + 32 observability cases), plus five separately collected proofs. Static parsing was not used for this count because it leaves parameterized templates unexpanded.

**Two independent final-source full runs: UNEXECUTED / BLOCKED.** Historical Phase 16's 948/948 twice does not verify Phase 17. Historical Phase 17's 970-test failures are preserved, not rerun blindly. The prepared runner discovers/reports current counts, requires all assertions/hooks executed and successful, compares counts across both fresh-store runs and rejects pending tests.

## 19. Unexecuted tests

Final-source store integration tests and all five live proofs remain unexecuted. The 28 setup-blocked historical checkout cases are enumerated in the matrix and are not counted as passes. Historical suite setup/dependency failure must be revisited on an immutable source. Collection is discovery, not execution. Full regression remains mandatory even though focused checks passed.

## 20. Files changed and reviewed snapshot

[Source review](phase-17-source-review.json) enumerates tracked modifications, untracked source, lockfile, test, workflow and documentation paths for the complete candidate snapshot. Phase 17.1 changes to pre-existing files are restricted to the draft Phase 17 workflow, observability runner/benchmark and proof test. Added files contain source/hash guards, readiness helpers, a dedicated runner, five harness tests, nine observability regression cases and this report/evidence. The old Phase 16 manifest, workflows, source builder and all prior reports are preserved. Production files and the lockfile have no Phase 17.1 edits.

The candidate is built in a new private local directory with its **own** `phase17-source-manifest.json`; the backend's historical manifest is not rewritten. Declarations and proof configuration are included. Actual `.env` files, secret directories, keys, development databases/volumes and raw diagnostics are excluded. A private-key/provider-token/JWT scan and path review found no such actual credential material in included source; synthetic test strings are retained.

## 21. Resource cleanup

No new Docker project or store container was started in Phase 17.1. Local HTTP/OTLP fixtures close their owned listeners; test child processes complete. Source/test fixtures use private temporary directories and do not issue development data commands. Historical four telemetry projects and the prior regression project reported owned cleanup. The new proof cleanup regression ensures all disposals and backend restart are attempted after one disposal fails; a cleanup error fails verification. No global prune, daemon restart or unrelated resource removal occurred.

## 22. Development data preservation

No SQL, Redis, RabbitMQ or Elasticsearch command was issued against development stores. All starting files remain in place; protected environment files and historical reports are hash-checked. Staged index, branch and HEAD remain unchanged. New diagnostics and snapshots are private local files; no external source transfer has occurred.

## 23. Remaining blockers and dedicated runner path

Local capacity is unsuitable for reliable store verification. No existing dedicated Linux runner/authorized transfer mechanism was available in the preceding session. The prepared path is a standard Ubuntu 24.04 / Node 24.21.0 runner, not paid/larger infrastructure. It requires an empty dedicated Docker host, four CPUs, 14 GiB Docker memory, 8 GiB host `MemAvailable` and 12 GiB free disk as planning floors; functional readiness is still required. It verifies source before/after gates, runs static/unit/disabled checks, the same five live proofs and live-Collector A/B/C measurements, then two independently provisioned full regressions. Each gate stops the run on failure. Raw logs/regression reports are excluded from public artifacts; bounded summaries, proof topology and performance results are retained.

User instructions §20 require **four separate approvals** before creating a Phase 17 verification branch, committing the reviewed snapshot, publicly pushing it, or running CI. None is granted by this Phase 17.1 prompt. Prior Phase 16 approvals do not authorize Phase 17 operations. Suggested branch: `verification/phase17-stabilization`, isolated from backend. No main change is authorized. The new manual workflow also requires default-branch registration before GitHub can dispatch it; that prerequisite needs a separate concrete authorization and is not included in the four actions. An otherwise authorized dispatch must wait for it. Artifact-storage overage may incur charges; no paid/larger runner is proposed.

## 24. Final Phase 17 status

**INCOMPLETE.** Baseline reconciliation and report-level failure classification are complete; underlying historical dependency root causes remain unknown. Focused tests and source safeguards pass. Actual Collector/Tempo/Prometheus/Grafana verification, five business proofs, real-store failure isolation, controlled live-Collector performance and two full regressions remain blocked/unexecuted. Development data, original changes/index/history and prior reports are preserved. No unauthorized Git operation, source upload or CI run occurred. Phase 17 cannot yet be marked fully verified.
