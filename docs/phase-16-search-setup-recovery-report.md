# Phase 16.3 — Search integration setup recovery

**Status: INCOMPLETE. Phase 16 cannot be marked fully verified.** No commit, push, frontend or Phase 17 work.

## Starting state and repository audit

Phase 16.2 had passed Node 24 typecheck/Compose validation and Messaging 22/22 twice, but the final stop-state guard had only static verification. Its last two Search runs passed 49 unit tests and left 80 integration cases unexecuted after setup failed; no full regression ran.

Read the Phase 16, 16.1 and 16.2 reports and inspected actual Search setup/reset/teardown, isolated runner, migrations/pools, Catalog HTTP, Elasticsearch initialization/rebuild, Redis and Messaging lifecycle. Initial git status was dirty/untracked and preserved. Initial whitespace check passed. Installed Node 22.23.3/npm 10.9.9 were unchanged; host verification used the retained temporary native Node 24.21.0 binary. Container workers dynamically reported **v24.21.0**. A 340-file SHA-256 manifest and starting git status are retained under `/private/tmp/commerce-v2-phase16-3/`, including actual ignored env files and all previous reports.

## Exact setup failures and confirmed causes

Historical Phase 16.2 Run 1 failed Elasticsearch functional warm-up after cluster health succeeded. Run 2 completed warm-up but failed initial rebuild job creation because PostgreSQL acquisition failed; PersistenceError discarded the original acquisition error.

The minimal new reproduction initialized and cleaned fixtures without running or filtering integration cases. Project `commerce-v2-stabilization-3f5ab341198d`: **setup passed; cleanup passed**. Cluster health took 529.16 seconds. The first failed actual setup operation afterward was **PUT of the exact owned warm index**, `ELASTICSEARCH_TIMEOUT`, 2,034 ms. Further index/document operations timed out at approximately 2,008 ms. Bounded retries recovered: functional warm-up took 10.37 seconds; initial rebuild took 8.39 seconds and retried a SWAPPING timeout. This was a recovered failed request, not a failed whole baseline probe.

Confirmed readiness defects:

- Cluster-health success preceded actual mapping/write/refresh/alias/search usability. The runner now checks these operations before entering hooks, within the remainder of its existing 900-second cold budget.
- Warm-up used match_all, whereas public Search uses full-text/fuzzy bool_prefix matching with relevance sorting. The first gated single test failed POST search with `ELASTICSEARCH_TIMEOUT` at 2,003.75 ms despite successful setup/cleanup. Warm-up now uses the actual production query builder.
- Fixture warm-up ignored timed_out responses. It now requires a complete response containing the exact owned document.
- Whole fixtures retained their exact indexes until overall project disposal. Repeated stages accumulated shards. An explicit creation/admission ledger now removes each fixture's exact indexes after draining writers. Its contribution to measured latency is **unproven**.

Later pool instrumentation recovered the previously hidden error: **PG_CONNECT_TIMEOUT**, during concurrent receipt processing, with pool total=10, idle=2, waiting=0 at failure reporting. This confirms a connection-establishment deadline, not authentication failure or proved exhaustion/leak. The precise source of connection/API latency remains unknown. Default ten-second idle eviction during warm-up was observed; baseline reacquisition succeeded. No PostgreSQL timeout was increased.

## Changes and files

Existing files changed:

- `apps/search-service/test/fixture.ts`: operation/stage diagnostics, acquisition/error snapshots, actual full-text readiness, completeness checks, tracked exact index teardown, and preservation of both setup/cleanup errors through AggregateError.
- `apps/search-service/test/integration.test.ts`: reset-stage diagnostics; original assertions, generation reuse and meaningful rebuild coverage retained.
- `scripts/integration-runner.mjs`: functional preflight, opt-in gated B–H verification in host/container modes, independent reports, bounded container startup, ownership-checked one-off/image cleanup and retained worker diagnostics.
- `infrastructure/docker/integration-test.Dockerfile` and its `.dockerignore`: include only the setup probe script in the test image; env/secrets/Git/host dependency exclusions retained.
- `test/integration-timing.ts`: actual isolated-worker Node 24 enforcement/runtime record, retaining timing diagnostics.

New files:

- `apps/search-service/test/setup-diagnostics.ts`: bounded ISO/monotonic begin/end logs, durations, outcomes, dependency and sanitized error codes; pool callback and promise acquisition overloads preserved.
- `functional-ready.ts` and `functional-ready.test.ts` in that directory: production API/query readiness and three regressions for incomplete/time-limited search, permission failure and exact ownership.
- `owned-indexes.ts` and `owned-indexes.test.ts`: exact generation/warm/mapping-failure creation ledger; two regressions cover draining, ambiguous creation/deletion, idempotent cleanup and rejecting foreign generations.
- `scripts/search-functional-preflight.mjs`: uses only the host port discovered from the generated project, including container mode; no development endpoint.
- `scripts/search-setup-probe.mjs`: setup-only mode and one representative real Catalog→projection→public Search test using existing Supertest/Node assertions, without filtering/skipping the 80-case file.
- `packages/messaging/test/shutdown.test.ts`: seven controlled runtime lifecycle cases supplementing real broker tests.
- This report.

No production business module, migration, contract, feature default or production request deadline changed. Setup/reset/teardown limits remain **120/15/60 seconds**; integration scenarios remain 20 seconds. Elasticsearch requests/pool acquisition retain their existing two-second budgets. No arbitrary success-inference sleeps, assertion weakening or deliberate skip was introduced.

## Messaging and dependency findings

The final stop-state guard is **dynamically verified**. Seven tests cover connected/repeated stop, reconnect, broker disconnect, pending heartbeat/close, late delivery while cancellation waits, unfinished handler without stale ACK, and late connection completion without recreation. They passed in host and container executions. The final focused lifecycle/readiness/ownership set passed **12/12**.

Host focused Messaging repeatedly passed **73/73** (22 real broker, seven lifecycle, 40 contract, four readiness cases). Real publisher confirms/negative confirms, routing, retry/DLQ, TCP disconnect, SIGKILL, manual ACK and bounded recovery remain exercised. The latest container Messaging run failed as recorded below; historical host passes do not replace that result.

PostgreSQL identity/authentication, real migrations, schema and Catalog source reads are staged. Pool logs expose total/idle/waiting counts and errors before wrapper sanitization. Failure snapshots contain only database/state/wait-category/count. Migration/coordinator clients and advisory locks release in finally. No development session was terminated.

RabbitMQ readiness includes authenticated management, real AMQP/vhost, exact topology/queue setup and publisher/consumer lifecycle. Redis uses the generated disposable DB-15 endpoint, no offline queue/reconnect, connection plus actual PING, and client destruction. No development Redis flush or broker mutation.

Elasticsearch preflight verifies actual mapping/document/refresh/alias/full-text operations and rejects incomplete results. Cleanup uses exact names from admitted jobs/creation attempts, never discovery sweeps or wildcards; successful deletion removes ledger entries. It waits for stopped consumers and tracked work. The existing pre-refresh delete-by-query/empty-index assertions and foreign-prefix protection remain intact. Failed cleanup remains failed, including during setup failure.

## Incremental execution and results

**Stage A:** final Node 24 typecheck, main optional Search/disposable Compose validation, script syntax and whitespace checks passed.

First gate (`b37485ccc3bb`): Messaging 73/73 and setup-only passed; single test failed the Search request deadline after successful setup/cleanup. E–H did not run.

Second host gate (`d9f8ad1b4901`), before whole-fixture index teardown change:

- Messaging 73/73; setup-only and single test passed.
- **Search Run 1: 132/132 passed**, 27.11 seconds; setup/teardown passed, zero skips/unexecuted cases.
- **Search Run 2: 132/132 passed**, 29.75 seconds; setup/teardown passed, zero skips/unexecuted cases.
- **Full regression Run 1: FAILED**, 871 passed, 11 failed, 58 automatically unexecuted Refund cases of 940; 3 failed files of 31; 1,121.38 seconds. Nine Search failures involved API/rebuild/reset/connection deadlines; two Checkout failures surfaced PersistenceError/internal error. Refund setup failed. Assertions were not waived.
- **Full regression Run 2: UNEXECUTED**, correctly gated after failure.

Final host fixture gate (`be9a4cae3037`), with exact index teardown:

- Messaging **73/73 passed**; setup-only and representative single test **passed setup/assertions/cleanup**, HTTP 200.
- **Search Run 1: FAILED**, 127 passed/seven failed of 134, 216.38 seconds. Setup and final teardown passed; teardown 89.80 ms. Failures included Elasticsearch cleanup/rebuild/read deadlines, exact private-database denial assertion receiving connection timeout, concurrent PostgreSQL acquisition, and a failed reset before an inbox-recovery body. Zero pending cases in JSON does not mean a failed-hook body executed.
- **Search Run 2 and both regressions: UNEXECUTED**, gated after this failure.
- Exact index cleanup succeeded for setup, single and full Search fixtures in 200.82/619.74/65.91 ms respectively. Corresponding total teardown was 293.78/1,414.41/89.80 ms.

First container gate (`22d5cd8e9dd2`): image build/store preflight passed; redundant version-only container launch exceeded 120 seconds before B. **No tests executed.** The container never started (created, Running=false, Pid=0). Its exact project/service/oneoff labels and `["--version"]` command were verified before manual removal and removal of only its private image tag. Why the daemon failed to start it is unknown. The duplicate launch was removed; real isolated workers now enforce/report Node 24.

Latest container gate (`87fc49147343`): actual test container started; worker runtime **v24.21.0**. **Messaging FAILED: 64 passed/nine failed of 73**, approximately 208.64 seconds by CLI (209.19-second JSON span). Seven controlled lifecycle cases passed. Real broker failures included mandatory-return classification, reconnect timeout and seven later cases unable to enter their bodies after the raw fixture connection closed with ECONNRESET. **C–H did not start**, as required. This is not a passing Messaging suite and not a Search test result.

Cleanup initially misclassified Docker's lowercase no-such-object response for its already auto-removed one-off. The check is now case-insensitive; syntax/typecheck/whitespace passed afterward. This final casing correction has static validation plus successful manual image disposal, not a runtime rerun. No exceptions indicating genuine cleanup failure are converted to success.

## Sleep, scheduling and remaining uncertainty

The interrupted regression recorded 941 successful parent PostgreSQL probes, zero errors, max query 4,213 ms and max one-second timer gap 249,283 ms; parent/worker samples had roughly 252/256-second gaps. Power logs confirm **clamshell sleep 14:58:53–15:03:02 IST on 14 October 2026**, 249 seconds, overlapping those gaps, plus a subsequent dark-wake interval. Temporary caffeinate did not prevent lid closure. Some failures preceded sleep and are not attributed to it.

The final host Search attempt had 427 successful probes, max query 1,716 ms and max timer gap 1,004 ms, with no comparable observed sleep gap. Container Messaging had 297 successful parent probes, max query 1,907 ms and max timer gap 1,006 ms, while its worker recorded 54,770/74,488 ms timer gaps and 47,010 ms event-loop delay. This establishes localized worker stalls while the parent kept scheduling. Guest scheduling, resource pressure and synchronous diagnostic I/O are possibilities, **not confirmed causes**. No global daemon restart, unrelated workload shutdown, permanent power change or production deadline increase was performed.

Further full verification needs stable dependency/worker responsiveness, remaining failure classification and clean runs under final source. Historical PostgreSQL acquisition error was lost; the new connection-timeout evidence does not retrospectively prove every earlier failure's cause. Container mode is not newly established green. No supported-image/security upgrade, deployment/HA/load test or later-phase work is claimed.

## Reproduction, ownership and approval

Evidence root: `/private/tmp/commerce-v2-phase16-3/`. Independent JSON reports are in `staged-run1`, `staged-run2`, `staged-run3`, `staged-container2`; baseline and focused regression JSON plus parent/worker JSONL diagnostics and a filtered power-log excerpt are retained. Full failed identities are in their JSON artifacts.

Runtime: `/private/tmp/commerce-v2-stabilization/node-v24.21.0-darwin-arm64/bin/node`.

Minimal probe command used `INTEGRATION_EXECUTION=host INTEGRATION_PROBE=search-setup INTEGRATION_PROBE_REPORT=<evidence>/setup-baseline.json INTEGRATION_DIAGNOSTICS_FILE=<evidence>/setup-baseline-diagnostics.jsonl node scripts/integration-runner.mjs`.

Gated commands used `INTEGRATION_EXECUTION=host` or `container`, `INTEGRATION_RECOVERY_STAGES=true`, `INTEGRATION_REPORT_DIR=<evidence>/<run>`, `INTEGRATION_DIAGNOSTICS_FILE=<evidence>/<run>-diagnostics.jsonl`, and `caffeinate -i -s node scripts/integration-runner.mjs`. B Messaging → C setup → D single → E/F complete Search → G/H complete regression are independent and stop on the first failed stage. The same existing runner/default test discovery is used.

Projects were uniquely generated with random loopback ports, fresh tmpfs and generated credentials. Search cluster roles/databases are search_test_admin/postgres, catalog_search_test/catalog_test_db and search_projection_test/search_test_db. Search vhost search_test is separate from unique Messaging namespaces in commerce_test. Redis DB 15 is disposable. Fixture prefixes are commerce_v2_products_test_<random>; preflight prefix is commerce_v2_products_probe_<project suffix>. No development volumes/env files are supplied to tests; containers receive no Docker socket.

**No execution approval was rejected in this continuation.** There is no approval-blocked command; execution/test/infrastructure failures above are actual results, distinct from older approval restrictions. Mode changes did not follow a denial and did not bypass one.

## Final safety and verification decision

Final read-only inventory confirmed **zero remaining owned containers or image tags** for all six Phase 16.3 projects. Scoped project disposal succeeded; two image cleanup failures were resolved by exact ownership-verified manual disposal. Evidence files are intentionally retained. Shared images, pre-existing rate-limit containers and unrelated projects were untouched. Temporary sleep assertions ended with their commands.

Final manifest comparison: only the six listed existing test/runner files changed; **no missing files**. Development env files, production modules and previous Phase 16 reports match their original hashes. Development data was preserved by confining every state-changing operation to owned disposable resources; no development-data export/comparison was performed. Optional flags/defaults unchanged. No commit or push.

- [x] Readiness defects identified/corrected and regression-covered; hidden connection error exposed.
- [x] Messaging final stop-state guard dynamically verified; final static checks pass.
- [x] Search setup, single test and teardown verified, including exact index cleanup.
- [ ] Two clean whole-Search passes under final source (intermediate 132/132 twice precede final cleanup).
- [ ] Full regression passes twice; zero failures/skips/unexecuted cases across final verification.
- [x] Owned resources cleaned; existing work, development data/defaults and historical reports preserved.
- [x] No commit, push, frontend or Phase 17.

**Final decision: Phase 16.3 INCOMPLETE. Phase 16 is not fully verified.**
