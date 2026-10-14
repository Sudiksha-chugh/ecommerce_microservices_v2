# Phase 16.1 — Search integration and full regression stabilization

Status: **incomplete**. Corrected teardown rerun was rejected at the execution approval step; legacy and full-regression stages were not advanced. The original Phase 16 report is preserved.

## Initial state and safety

Read the complete Phase 16 report, Search architecture, Phase 15 report and Phase 14.1 report; inspected current runner, real Search fixtures, broker topology and lifecycle. Existing dirty/untracked work was recorded in a checksum manifest before edits. No development database, Redis key, Elasticsearch index or RabbitMQ queue was modified. Tests use generated fresh Compose identities, random loopback ports and tmpfs stores. Node 22.23.3/npm 10.9.9 remain installed unchanged; verification uses temporary native ARM64 Node 24.21.0/npm 11.19.0.

Initial machine: macOS Darwin 24.6.0 ARM64, 16 GiB physical memory, about 8.54 GiB used swap and 52 GiB available disk. Docker Desktop 4.91.0, Engine 29.8.0, Compose 5.5.1; native ARM64 VM, ten CPUs and 8,319,504,384 bytes memory. Thirty-seven unrelated containers were running; none was stopped or changed.

## Baseline and reproduced failures

Initial whitespace check and Node 24 typecheck passed. Stage B: 49 Search unit tests discovered/executed/passed, zero failures/skips/unexecuted; 1.75 seconds across the JSON report span, host Node 24 with no external stores. The unchanged Stage C attempt failed during broker provisioning with UND_ERR_SOCKET before test discovery; it cleaned its generated project. The first host-mode attempt reproduced the same startup failure. These are infrastructure failures, not passing integration results.

After authenticated readiness was added, Search reached database migrations and broker publisher readiness, then failed the existing 120-second setup hook. Results: 129 discovered, 49 executed/passed, zero individual assertion failures, 80 automatically unexecuted/skipped due to setup failure; 121.48 seconds. Eighty includes three added cleanup regressions. No test was intentionally skipped. This failure was investigated before advancing to legacy/full stages.

## Confirmed causes and fixes being verified

Elasticsearch delete-by-query uses a search snapshot. Fixture deletion now refreshes its exact generation first, waits for completion, checks timeout/version conflicts/failures and verifies an exact empty index. Cleanup requires quiescence: consumers stop and pending handlers/projection/rebuild promises drain. Retry queues are purged before the main queue. Ordinary cases retain the real initial baseline; rebuild-specific cases continue exercising the production coordinator. New tests cover an unrefreshed document, an in-flight consumer and a lost delete response. All three new cleanup regression assertions passed in the subsequent 129-test run. That verifies their scenarios, while whole-suite stability still requires a clean run including teardown.

The old Search setup swept all indexes with a shared test prefix. That exceeded this fixture's generation ownership; the sweep is removed. An exact differently owned generation is retained by cleanup regression coverage. Search setup now registers raw channel/connection cleanup before later setup can fail. My initial failure-path change closed the channel and connection concurrently; it was corrected to close the channel first. Concurrent closure can prevent ChannelCloseOk from resolving amqplib's channel-close promise. Installed amqplib source confirms this dependency; the latest serialized path still requires rerun evidence.

RabbitMQ ping was insufficient for authenticated management readiness. Two fresh startup attempts failed at management HTTP after ping-based Compose readiness. Disposable health checks now require an authenticated HTTP 200 from the private management endpoint, with the original five-second health deadline. No development health/configuration was changed. Legacy Messaging/Outbox test queue selection uses exact names rather than registry positions, retaining the same expected routes/assertions.

## Host pause evidence

The macOS power log records clamshell sleep from 2026-10-14 08:07:49 to 08:10:41 IST: 172 seconds. This overlaps the historical final Search attempt and matches its 171,862 ms host timer gap. Earlier power-log intervals include 1,029/977/966-second sleep intervals during the prior prolonged regression run. System sleep is therefore an evidenced contributor to historical pauses; not every older timeout is attributed to it. A temporary caffeinate idle/system-sleep assertion is used during current verification and will be terminated afterward. Lid closure can still suspend the machine; no permanent power setting was changed.

The instrumented host Search attempt recorded 118 successful PostgreSQL probes, zero failures, a maximum query of 1,475 ms and maximum one-second timer interval of 1,005 ms. Worker ten-second heartbeat samples were regular, with tens of milliseconds event-loop delay after import. No comparable sleep gap occurred in that attempt. Slow Elasticsearch functional readiness and teardown must be distinguished from host sleep. High swap usage suggests pressure but does not establish a precise scheduling/GC/connection-exhaustion cause.

## Infrastructure instrumentation

Runner diagnostics use ISO and monotonic timestamps, event-loop delay/utilization, CPU/RSS, database connection/query timing, AMQP readiness, Elasticsearch startup, Docker lifecycle timing and scoped container state/resource samples. Worker hooks report test/hook durations and scheduling samples. Fixture instrumentation records individual Elasticsearch operations and teardown steps. Logs are bounded and omit connection URLs, credentials, SQL bodies and customer data. Docker control commands now have bounded startup/cleanup budgets; application RPC and existing test-hook deadlines are unchanged. Interruptions terminate the active owned command and lead to scoped cleanup.

An explicit INTEGRATION_EXECUTION=host mode runs native Node 24 against the same freshly provisioned disposable stores with generated per-service files/ports, including Search and Notification admin connections. Default container mode remains available; neither mode reads actual development env files for test-store credentials. No Docker socket is exposed to a test container.

## Pending verification and boundaries

Stage A/B passed. The next focused run discovered/executed **129 tests: 129 passed, zero failed assertions/skipped/unexecuted**, 86.18 seconds. Nevertheless, the suite failed its **60-second afterAll teardown hook**, so success=false and the command exited 1. The failed hook is retained in evidence; passing assertion counts are not presented as a clean suite pass. Serializing channel closure before connection closure was applied afterward; its rerun and repeat were rejected by the execution approval step and did not execute. Legacy Gateway/Catalog/Messaging/Outbox/Inventory/Notification and rate-limit verification, Checkout/Refund verification, and full regression Run 1/Run 2 were therefore **not executed in Phase 16.1**. Historical passing results are not substituted for these required runs. Phase 16 and Phase 16.1 cannot be considered fully verified.

Production Search/Catalog/version/ACK/rebuild/authorization/rate-limit business code is unchanged. Earlier actual optional-profile smoke and physical Elasticsearch restart passes remain historical evidence; expensive checks are not repeated merely for fixture-only changes. Main optional Compose profile still requires validation. No Phase 17, frontend, commit or push.


## PostgreSQL, RabbitMQ and Elasticsearch findings

Initial measured host PostgreSQL connection/query establishment was 64/22 ms; subsequent attempts measured 143/15 ms and 44/8 ms. Elasticsearch cluster readiness took 296.69 seconds in the failed setup attempt and 42.17 seconds in the 129-assertion run. The latter AMQP connection took 58 ms; its PostgreSQL end snapshot showed only the active diagnostic connection, with no idle transaction or lock-wait row. Search migrations and Catalog source setup completed. Fresh-run probes had no failed queries. No verified connection/channel exhaustion, idle-transaction leak, advisory-lock defect or application SKIP LOCKED regression was found. End-of-run activity snapshots are bounded summaries, not proof of every transient condition.

Search uses a dedicated fresh PostgreSQL cluster and search_test broker vhost; legacy tests use their own generated test databases and commerce_test vhost/unique queue namespaces. Registering setup raw broker resources early addresses failure-path leaks. Serial protocol close ordering addresses an identified teardown hazard; its latest implementation remains unverified. The 129-test run exercised publisher confirms, manual ACK/retry/DLQ, restricted credentials, real TCP disconnect, consumer SIGKILL, mapping failures, lost Elasticsearch replies and rebuild/alias/rollback tests with all assertions passing.

Elasticsearch cold startup is kept outside test hooks in the isolated runner. The functional warm-up/setup and requests retain existing command budgets. The runner now releases its initial diagnostic PostgreSQL client in finally even if identity querying fails. No normal application timeout, global hook/test deadline, version/tombstone logic, source capture, alias safety or reconciliation assertion was weakened. Setup/teardown failures remain suite failures.

## Files created or modified

Created: `apps/search-service/test/cleanup.ts`, `scripts/integration-observer.mjs`, `test/integration-timing.ts`, this report and `docs/phase-16-stabilization-results.json`.

Modified: `apps/search-service/test/fixture.ts` and `integration.test.ts`; `scripts/integration-runner.mjs`; `vitest.config.ts`; `infrastructure/docker/compose.integration-test.yaml`; `compose.search-test.yaml`; `packages/rate-limiting/test/fixture.ts`; `packages/messaging/test/rabbitmq.test.ts`; `packages/event-persistence/test/rabbitmq-integration.test.ts`. Application production modules and migrations were unchanged. The earlier Phase 16 report was checksum-verified unchanged.

## Compose and final safety checks

Main optional Search profile, disposable regression and disposable Search Compose definitions passed config validation. All eight actual environment files still match the retained Phase 16 preservation checksums; no actual environment file was edited in Phase 16.1. The earlier profile build/smoke and physical restart successes are historical, not newly executed results. These expensive checks were not repeated because production profile/application code was unchanged.

All four purpose-created Phase 16.1 projects reported successful cleanup; a read-only final inventory confirmed none remained. The existing commerce-v2-rate-limit-test-ef695590 container was created on October 13 at 19:44 UTC, before this task, and was deliberately left untouched. The temporary caffeinate process was terminated. No pre-existing file was removed. No development migrations, database resets, Redis-key deletions, Elasticsearch-index deletions, broker changes, unrelated-container shutdowns, feature enablement, previous-project edits, commit or push occurred.

Remaining limitations: latest channel/connection teardown ordering needs a clean focused repeat; full regression must pass twice, including independent Notification/rate-limit/Checkout/Refund coverage. High swapping and service latency remain observed environmental conditions, not established causes of every failure. Verification requires avoiding system sleep. The execution approval rejection prevented the requested next test run; no approval reason was supplied. Stop after Phase 16.1; no Phase 17 work.
