# Phase 17.1 authorized Linux verification

Status: **INCOMPLETE**. This new local report preserves the earlier stabilization and observability reports. It is not included in the proposed five-path diagnostic correction commit.

## Authorized source and registration

User separately authorized branch creation, exact reviewed snapshot commit, public branch push and one standard-runner dispatch. Isolated branch `verification/phase17-stabilization` was created from backend HEAD `e501bc4b9a6ba1e346aa64d9d43da1609c5f455c`. Commit `ae2b18f7e3abb4bdc20709abaa14ac291e013499` contains the 411 reviewed files plus manifest, identity `7830ded0e2c939236ea4ce0ffe77948269c9426359ea7fef7c3cf81741b7cffe`. It was pushed without force. Two pre-existing whitespace warnings in the exact reviewed snapshot were retained rather than changing approved source.

After separate explicit authorization, registration commit `b1a50729f1a5303a8ebac6d01006797085afbcbd` added ONLY `.github/workflows/phase17-observability.yml` to main. No application source was pushed to main. Workflow content SHA256: `2404d3eea205caf7e535bf0ce3536695b66ba188bb52e92443e965d7a10f1ab9`.

## Run and source validation

[Run 38636606220](https://github.com/Sudiksha-chugh/ecommerce_microservices_v2/actions/runs/38636606220) used Ubuntu 24.04, Node 24.21.0 and the exact approved commit/manifest. One dispatch returned HTTP 204. No additional run or rerun was triggered.

Host: four CPUs, 16,766,414,848 bytes RAM, 15,423,868,928 bytes available, zero swap used; Docker memory equals host memory; 91,874,050,048 bytes free disk. The dedicated host initially had no running containers. Planning floors passed.

Passed gates:

- Locked dependency install, source identity checks, strict typecheck and compiled preload.
- Collector configuration validation, Prometheus configuration validation, dashboard structure checks and static owned cleanup.
- Harness: **40/40**, zero failures/pending/failed suites.
- Observability unit/runtime tests: **32/32**, zero failures/pending/failed suites.
- Disabled focused checks: **228/228**, zero failures/pending/failed suites.

## Actual live readiness

Telemetry project: `commerce-v2-observability-f81625e03ea2`.

- Collector OTLP HTTP empty-request acceptance: passed, first attempt, 30.5 ms. This is receiver readiness, not successful application trace ingestion.
- Tempo readiness: passed, 61 attempts, 15,089.6 ms.
- Prometheus configuration API: passed, first attempt, 5.2 ms.
- Grafana health: passed, first attempt, 2.1 ms.
- Both Grafana datasource health checks: passed, 23.4 ms.
- Grafana unauthenticated API: correctly returned 401.
- Seven dashboards: provisioned; dashboard queries and actual trace navigation were not reached.

Business-store project: `commerce-v2-stabilization-7d1776ef0992`. PostgreSQL/RabbitMQ provisioning, Redis and Elasticsearch readiness including functional preflight passed; stores were ready at 21:00:47 UTC. Diagnostic database probe: nine queries, zero failures, maximum query duration 1.05 ms. These results establish that the Linux run cleared the readiness blocker; they do not prove the cause of the four historical local failures.

## Failure and evidence limit

The five-proof child returned exit 1 at 21:00:56 UTC. The runner retained only `Proof child failed 1`, not the underlying assertions. The JSON reporter wrote a report copied to `live/proof-tests.json`, but that file was intentionally excluded from artifact upload to avoid publishing raw diagnostics. The parent failed to create a sanitized failure summary before exit. Standard GitHub-hosted execution ended; the omitted report cannot now be retrieved from that machine.

This is a confirmed **verification evidence-retention defect**. The actual proof failure cause and per-case pass/fail/setup counts remain unknown. Do not infer them from container restart timestamps or the exit code. No five-proof pass can be claimed. Actual application ingestion, parentage/metrics proof, business failure isolation, live-Collector performance and both full regressions remain uncertified; performance and full regressions were not reached.

Both owned projects reported cleanup successful. Captured telemetry containers were running, not OOM-killed; their sampled use was below configured limits. This does not diagnose the earlier proof assertion failure. No unrelated container was changed.

## Prepared diagnostic correction

Five paths, no production or workflow changes:

1. `scripts/observability-runner.mjs` attaches sanitized proof test evidence to the already-retained result on failure.
2. `scripts/verify-phase17.mjs` attaches sanitized evidence for other failed test gates.
3. `scripts/verification-test-evidence.mjs` extracts exact failing/unexecuted names, assertions, stack frames and suite setup messages; redacts credentials/JWTs, bounds size and explicitly marks truncation.
4. `scripts/verification-test-evidence.test.mjs` covers retention, redaction and truncation.
5. `phase17-source-manifest.json` records the corrected source in the isolated verification worktree only.

New candidate identity: `3357866de9d910ed750ea56dcb8d4c529966b98b15f6cc2308e9e240a3268e45`, 413 source files plus manifest. All **42 harness tests pass**; syntax and strict typecheck pass. The reader was also exercised against an actual failed Vitest JSON report and retained its three failed names/stacks. No business test/assertion/deadline was weakened; no speculative business fix was applied.

Separate authorization is required for this correction commit, public branch push and one additional standard-runner run. Existing approvals covered the earlier exact snapshot and one consumed run. No main change or re-registration is needed for this correction.

## Preservation and status

Original backend branch and HEAD, its index, actual environment files, historical reports and development data remain preserved. Raw downloaded logs are private under `/private/tmp/commerce-v2-phase17-1`; no development data command was issued. The proposed correction and this report remain uncommitted locally pending the required approvals. Phase 17 remains **INCOMPLETE**. Phase 18 was not started.

## Diagnostic-corrected run and confirmed route defect

After separate G/H/I approvals, diagnostic correction `be9c08777cb04da91e1816f9e7c3481deae2e80f` was committed and pushed; [run 38700412537](https://github.com/Sudiksha-chugh/ecommerce_microservices_v2/actions/runs/38700412537) was dispatched exactly once. It again passed readiness, static/typecheck/preload, 42 harness cases, 32 observability cases and 228 disabled-focused cases. Both owned projects cleaned up. The retained report now shows **five tests executed, zero passed, five failed, zero pending**, all at `integration.proof.ts:107:129`: the Gateway `/checkout` log lookup returned undefined. No setup error or evidence truncation occurred.

The Gateway registers `/checkout` and `/checkout/:orderId/retry` in an Express route array. The instrumentation recorded `req.route.path.join('|')`, giving `/checkout|/checkout/:orderId/retry`; the proof correctly requires the matched `/checkout` template. The same incorrect label would break the strict trace-parentage lookup later. Checkout completion, one charge, inventory totals, retry and DLQ assertions precede this failure and passed in all five cases; remaining proof assertions were not reached. Actual trace retrieval, metrics verification, live-Collector benchmark and final regressions remain uncertified/unexecuted.

A new isolated HTTP regression reproduced the incorrect combined template before the fix. The prepared correction selects the matched registered string using the same path-to-regexp matcher as Express, caches matchers per registered route and never exports concrete path IDs. It declares already-installed version 8.4.2 directly; the lockfile adds only the observability workspace dependency reference. The original five proof names and assertions are unchanged. All 33 observability tests, 42 harness tests, typecheck and compiled preload pass.

Candidate identity `edd1f34687aa21c93f4299e7c86e8d21d0fdc474f4dd2e190f4047df635701de`; five proposed paths are the middleware, regression test, observability package declaration, lockfile and manifest. No workflow/main change is needed. These changes are prepared but not committed/pushed; a further run requires separate authorization. Detailed retained counts, failures and checks are in `phase-17-remote-verification-results.json`. This local report/results pair is not part of the proposed five-path commit.

## Route-corrected run: five proofs pass; restart plumbing failure

After separate J/K/L approvals, route correction `55a330a13726d21c6febe5879e6cc4ce2092a05f` was committed and pushed, and [run 38703243417](https://github.com/Sudiksha-chugh/ecommerce_microservices_v2/actions/runs/38703243417) was dispatched exactly once. It passed 42 harness, 33 observability and 228 disabled-focused cases, typecheck, preload and stack/readiness checks. **All five original business proofs passed, zero skipped, zero failed suites.** The retained `flow-proof.json` establishes actual Collector→Tempo trace retrieval and HTTP/Rabbit parentage, PostgreSQL/Redis/Elasticsearch spans, bounded positive application metric series, request/log correlation, one charge/committed inventory, retry/DLQ/ACK assertions and all four backend-outage business cases.

The outer runner then failed with `fetch failed`, cause `ECONNREFUSED`, on its first post-suite Grafana trace request. It reused the initial host port after the Grafana container had been stopped and started. All four backend containers had restart timestamps; none was OOM-killed, and owned telemetry/business-store cleanup passed. Full regression and live-Collector benchmark were not reached. Grafana authentication, datasource health and dashboard provisioning passed before outages, but chart queries/navigation were not yet verified.

A bounded local diagnostic used two sequential, owned, cached Alpine fixtures capped at 16 MiB each, with no store process or development mount. It demonstrated an ephemeral host port changing from 59658 to 59660 across stop/start; an explicit port remained 59662. In both fixtures a tmpfs marker disappeared on restart. All probe resources were removed. These are confirmed test-infrastructure defects: stale endpoints, no post-restart readiness check, and querying initial data after intentionally clearing temporary telemetry storage. They are not business or instrumentation production defects.

The prepared seven-path verification-only correction reserves explicit loopback ports, records/checks stable endpoints, verifies actual Grafana trace navigation and all existing dashboard queries inside the normal proof before outage-induced data loss, then requires Collector/Tempo/Prometheus/Grafana/datasource/dashboard readiness again after restart. Existing five names and assertions remain; no production deadline, business semantics, workflow or main change. Added helper tests reject incomplete traces/empty query series, and verify reservation cleanup. All 47 harness tests, strict typecheck, unchanged-five discovery and a native reservation/release check pass. Candidate identity `9bcf86421b72dd5eea2111940d0d77d92081500b7d6251060f9a55017310841b`, 416 source files plus manifest. Separate correction commit/push/run approvals remain required. This local report and `phase-17-route-corrected-verification-results.json` are excluded from that proposed seven-path commit.

Phase 17.1 remains INCOMPLETE until Grafana live queries/navigation, post-restart readiness, live-Collector performance and the two independent full regressions complete. The original backend HEAD/index, protected files and development data remain preserved; no Phase 18 work.

## Final authorized restart-corrected run — COMPLETE

After separate M/N/O approvals, seven-path correction `e4ed6215c19f57705744a807a995eb85f44c0723` was committed and pushed. [Run 38705147319](https://github.com/Sudiksha-chugh/ecommerce_microservices_v2/actions/runs/38705147319) completed successfully against identity `9bcf86421b72dd5eea2111940d0d77d92081500b7d6251060f9a55017310841b`. Results: 47/47 harness, 33/33 observability, 228/228 disabled-focused, 5/5 strengthened live proofs, all 15 Grafana queries plus trace navigation, recovered backend/datasource/dashboard readiness, nine actual-Collector A/B/C benchmark processes and **981/981 full regression twice on independent stores**. Zero failures, skipped/unexecuted cases or failed suites; owned cleanup verified.

Final performance has material overhead: median A/B/C HTTP p95 1.403/1.833/1.957 ms and throughput 6740/4730/4440 requests/s, zero workload errors. It is a bounded microbenchmark, not production capacity approval. The final report documents attribution limits and bounded optimization recommendations. No arbitrary performance threshold or claim of negligible cost is made.

The previous sections remain historical records. Authoritative final outcome and source/safety limits: `phase-17-final-verification-report.md` and `phase-17-final-verification-results.json`. These final local documentation updates remain uncommitted. Original backend HEAD/index, existing changes, 24 protected files and development data remain preserved. No additional run or Phase 18 work.
