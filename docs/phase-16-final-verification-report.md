# Phase 16.2 — Search teardown and final regression verification

Status: **INCOMPLETE; Phase 16 cannot be marked fully verified**. No Phase 17 work, commit or push.

## Starting status

Phase 16.1 recorded 129 passing tests but a failed 60-second afterAll hook. The subsequent serial raw channel/connection closure was already implemented but unverified. Full regression had not executed. Historical reports remain unchanged. Continued from the dirty repository, with the retained `/private/tmp/commerce-v2-phase16-2/before.json` preservation manifest. Host Node is 22.23.3; all verification uses the existing temporary Node 24.21.0 binary.

## Investigation and confirmed findings

An initial disposable startup attempt (`commerce-v2-stabilization-5629e94bd618`) exceeded the runner's unchanged 120-second Docker startup deadline, before discovery. It cleaned its project successfully. Read-only inventory and process inspection found an abandoned prior Phase 16.2 project `commerce-v2-stabilization-c3b58301acf0` with five stores and no active runner. Exact scoped cleanup was authorized and executed; no unrelated container was stopped. A subsequent fresh project started, but this correlation does not prove why startup stalled.

The instrumented reproduction (`commerce-v2-stabilization-33fc097cae06`) discovered 129 tests: 125 passed, four failed; no pending tests in Vitest's report. Setup succeeded. The teardown hook again exceeded 60 seconds. Raw channel closure completed in 195 ms; raw connection closure completed in 458 ms. Teardown then stalled in the last restricted-credential Messaging consumer's stop. Pending projection/rebuild work was zero; service pools each had one idle connection and no waiters. The existing raw-close ordering alone did not resolve the failure.

Confirmed code defect: the Messaging shutdown deadline covered handler draining only, leaving consumer cancellation, startup completion and connection-close protocol waits unbounded. The reproduction locates the stall within manager stop; the exact internal protocol stage of the original stall remains unknown. Subsequent normal Search teardown and forced-cancellation recovery both complete, but cold infrastructure failures prevent final whole-Search confirmation. Resource contention and store/VM latency remain possible contributors, not established root causes.

Four other failures are retained: rollback fixture rebuild deadline; lost Elasticsearch response taking 1,289 ms against the unchanged <1,000 ms assertion; TCP-disconnect recovery deadline; and the subsequent source-export test's 15-second beforeEach timeout (its body did not execute). These are not erased or counted as passing. Three cleanup regressions passed, including exact ownership, unrefreshed deletion and interruption recovery. Reproduction duration: 188.59 seconds.

## Changes

- `apps/search-service/test/fixture.ts`: begin/end teardown stage diagnostics with wall and monotonic time, durations, outcomes, sanitized codes, pending work, pool counts and manager state; lifecycle sinks for publisher/consumers. Raw channel still closes before raw connection. Closure errors are reported rather than silently swallowed.
- `packages/messaging/src/connection.ts`: apply the existing configured shutdown budget to the whole shutdown sequence, with stage/active-handler/pending-confirm diagnostics. Stop retry scheduling immediately. Retire the session, abort handlers and reject outstanding confirms on expiry; destroy its AMQP transport so unfinished manual-ACK deliveries are recovered by the broker. Prevent a late connection opening after stop from setting up consumers.
- `packages/messaging/test/rabbitmq.test.ts`: real TCP-proxy regression holds cancellation replies, checks bounded stop, zero ACKs for unfinished work, and redelivery of the original event.

No business assertions, hook deadlines, Elasticsearch command budget, feature defaults, migrations or event contracts changed. No arbitrary sleeps or larger global timeout were introduced.

## Shutdown dependencies and resources

Fixture: raw channel → raw connection; Messaging stop accepting/reconnecting → consumer cancel → handler drain → retire session/reject confirms → connection close; projection/rebuild promises → Catalog HTTP close → PostgreSQL pool end. A finite Messaging deadline uses transport-loss recovery when protocol replies do not arrive. Application Search HTTP shutdown precedes poll worker stop, Messaging stop and pool end. Poll-worker stop prevents rescheduling and drains its current tick. Coordinator steps release their advisory lock and checked-out client in finally.

PostgreSQL reproduction: 181 successful probes, zero errors, maximum round trip 2,124 ms; parent one-second timer maximum 1,005 ms. No pool waiters at the teardown stall. This does not rule out transient query latency. No development sessions were terminated.

Elasticsearch cleanup refreshes only the exact fixture-owned generation before synchronous delete-by-query, checks conflicts/failures/timeouts and asserts zero documents. No wildcard cleanup. Embedded fixture index resources are removed with the runner's owned tmpfs cluster. Production reconciliation/rollback/alias semantics are unchanged.

Redis fixture uses only generated disposable DB-15 endpoints and disables reconnect. Its client is destroyed before Search teardown. Catalog and Elasticsearch use fetch with bounded AbortSignal deadlines and consume response bodies; neither owns a separate dedicated client. Fixture HTTP servers close active sockets after their users stop. Child crash processes and proxies remain scenario-owned.

## Host sleep and timeout policy

Historical clamshell sleep evidence remains in Phase 16.1. The reproduced failure has regular host/worker scheduling samples, so it is not attributed to host sleep. Existing temporary caffeinate was observed; no permanent power setting was changed. Host remains awake during verification. The Search afterAll deadline remains 60 seconds, setup 120 seconds, application request deadlines unchanged. Existing Messaging shutdownTimeoutMs now bounds all shutdown stages rather than just draining.

## Verification evidence

Node 24 typecheck passed after the shutdown change. `git diff --check` passed. Disposable regression and Search Compose definitions passed config validation. Main optional Search profile passed read-only config validation with existing local credentials and Search/Notification example defaults; no services started by validation. An example-only validation failed because its password placeholders are intentionally empty; this was configuration input, not a Compose syntax defect.

Intermediate fixed Search Run 1: **129/129 passed**, setup and teardown passed; teardown 12.28 ms. Three cleanup regressions passed. Combined Messaging verification: 21/22 passed, including the new blocked-cancellation recovery regression. Total combined run: 150 passed, one failed, zero pending of 151; exit 1. Project `commerce-v2-stabilization-728ce0445fe4` cleaned successfully. The older reconnect test counted three handler calls instead of two because it disconnected after handler entry without an ACK barrier. Its fixture now holds the first handler, observes the broker’s unacknowledged delivery, releases it and observes zero unacknowledged before disconnect. Exact original call-count and one-consumer assertions remain. This change affects only Messaging tests; Search and application code are frozen for repeat verification.
Intermediate Search Run 2: 129/129 assertions and all Search hooks passed; Messaging 22/22 assertions passed. Combined command exited 1 with 16 unhandled heartbeat exceptions, despite JSON success=true. This is **not a clean verification pass**. Scoped project cleanup succeeded. Investigation confirmed the initial deadline fallback used bare socket.destroy(), which does not necessarily emit the error/end events amqplib uses to clear its heartbeater. Corrected to destroy with a sanitized Error (and an error listener for late setup sockets), invoking library cleanup. The final paired results are recorded below.
Notification, rate-limit, checkout/refund: **unexecuted in Phase 16.2**. No historical passing counts are substituted.
Full regression Run 1: not executed.
Full regression Run 2: not executed.

## Safety and approvals

Development environment files match the retained preservation manifest. Prior changes are preserved; no reset, checkout, migration against development, Redis flush, wildcard index deletion or development RabbitMQ mutation occurred. Disposal uses unique generated Compose identities, fresh tmpfs stores, generated credentials, Search-only PostgreSQL cluster/vhost and isolated Redis. No global Docker cleanup. Historical reports are preserved. No commit or push.

Current commands have been approved; no execution rejection in this continuation. Phase 16.1 historical rejected commands are not treated as failures. Exact run commands and final cleanup verification will be recorded below when runs settle.

## Remaining work

Establish two clean whole-Search runs under the final code, then execute full isolated regression twice (including Notification/rate-limit/checkout/refund) with successful hooks, zero skips/unexecuted cases and scoped cleanup. Search setup readiness and database connection latency remain unresolved. The root of the substrate latency is unknown; restarting Docker, stopping unrelated workloads or altering development infrastructure was not performed. Further identical retries have not established stable whole-Search verification. No full regression was advanced past the unmet two-clean-Search prerequisite.

## Exact execution commands

Runtime for each command is `/private/tmp/commerce-v2-stabilization/node-v24.21.0-darwin-arm64/bin/node`; prefix `INTEGRATION_EXECUTION=host`. Diagnostic/output files live in `/private/tmp/commerce-v2-phase16-2/`.

- Startup attempt: `node scripts/integration-runner.mjs apps/search-service/test --reporter=default --reporter=json --outputFile=/private/tmp/commerce-v2-phase16-2/search-run1.json`. Failed before discovery, scoped cleanup succeeded.
- Instrumented reproduction: same arguments with output `search-run1-retry.json`. Failed as detailed above, scoped cleanup succeeded.
- Fixed Run 1: `node scripts/integration-runner.mjs apps/search-service/test packages/messaging/test/rabbitmq.test.ts --reporter=default --reporter=json --outputFile=/private/tmp/commerce-v2-phase16-2/search-fixed1.json`.
- Fixed Run 2: same arguments with output `search-fixed2.json`.

All requested command approvals in this continuation were granted. No bypass, global cleanup or security-setting change.

Final paired focused command: `INTEGRATION_EXECUTION=host INTEGRATION_REPEAT=2 INTEGRATION_DIAGNOSTICS_FILE=/private/tmp/commerce-v2-phase16-2/search-final-diagnostics.jsonl /private/tmp/commerce-v2-stabilization/node-v24.21.0-darwin-arm64/bin/node scripts/integration-runner.mjs apps/search-service/test packages/messaging/test/rabbitmq.test.ts --reporter=default --reporter=json --outputFile=/private/tmp/commerce-v2-phase16-2/search-final.json`. Each iteration has independently generated Search fixture identities and recreated Search test databases; the runner's unique project is removed after both. The two output files remain independent.

## Final paired focused results

The first paired attempt (`commerce-v2-stabilization-453d19f99963`) failed before discovery: existing Docker up deadline exceeded while RabbitMQ readiness was pending. PostgreSQL/Redis were healthy. No tests ran. Cleanup succeeded. No timeout was increased.

Retry project: `commerce-v2-stabilization-18e1bc6ce2f8`. Exact command was the final paired command above with diagnostic file `search-final-retry-diagnostics.jsonl` and output `search-final-retry.json`. It produced independent `search-final-retry.json` and `search-final-retry-repeat2.json` reports.

**Search Run 1: FAILED setup; cleanup/teardown completed.** 129 discovered: 49 unit cases executed/passed, 80 integration cases automatically unexecuted/skipped because the functional Elasticsearch warm-up exceeded its existing 20-second readiness deadline. No deliberate skip was added. Search failure cleanup completed in approximately 672 ms. Combined run with Messaging: 151 discovered, 71 passed, 80 pending/unexecuted, zero individual failed assertions; suite failed. Duration 73.57 seconds. Messaging 22/22 passed, including blocked-cancellation redelivery, with no unhandled heartbeat errors.

**Search Run 2: FAILED setup; cleanup/teardown completed.** 129 discovered: 49 unit cases executed/passed, 80 integration cases automatically unexecuted/skipped. Elasticsearch warm-up succeeded, but the initial rebuild's `transaction()` failed to acquire a PostgreSQL pool client and surfaced PersistenceError. The wrapper does not retain the specific underlying acquisition error, so exact attribution is unknown. Search failure cleanup completed in approximately 138 ms. Combined run: 151 discovered, 71 passed, 80 pending/unexecuted, zero individual failed assertions; suite failed. Duration 198.60 seconds. Messaging 22/22 passed again, including the blocked-cancellation regression, with no unhandled heartbeat errors.

Runner exited 1 for the failed suite hooks and removed its exact project successfully. Elasticsearch cold readiness took 591.03 seconds. Across the paired run there were 268 successful PostgreSQL probes, zero probe errors, a maximum round trip of 2,945 ms and maximum parent timer interval of 1,018 ms. These measurements establish latency and continued parent scheduling; they do not prove resource contention, host sleep or an application transaction defect.

A final static audit added a stopped-state guard before starting newly delivered handlers while cancellation is pending. It does not ACK those deliveries. Node 24 typecheck and whitespace checks pass after this guard. The guard itself has not been runtime-rerun; earlier Messaging passes precede this final one-line change. All final whole-Search/full-regression verification therefore remains required under final source.

**Full regression Run 1: UNEXECUTED. Full regression Run 2: UNEXECUTED.** The task requires two clean Search runs before full regression, which has not been achieved. Notification, Gateway/rate-limit, Catalog, event-persistence, Inventory, Orders, Payments, Checkout and Refund regression coverage was not newly executed here. Only Search and Messaging were run in this continuation.

## Final preservation and cleanup

Final read-only Docker inventory contains none of this continuation's projects: `5629e94bd618`, `33fc097cae06`, `728ce0445fe4`, `0c01b5043fcc`, `453d19f99963`, `18e1bc6ce2f8`, or the abandoned retained `c3b58301acf0` project. All completed runner attempts reported cleaned_up. No global cleanup occurred. The pre-existing rate-limit container `commerce-v2-rate-limit-test-ef695590-redis-1` and unrelated projects remain untouched. No current test runner remains from the completed commands; scenario child/process cleanup and project disposal completed.

Checksum comparison with the retained Phase 16.2 manifest found only these pre-existing files changed: Search fixture, Messaging connection, and Messaging broker tests. No file is missing. The only new repository artifact is this report. Development env files and original Phase 16/16.1 reports match their retained hashes. Development data was preserved by restricting every state-changing operation to owned disposable resources; no database-content export/comparison of development stores was attempted. Optional features remain opt-in. No commit, push, frontend, previous-project edit or Phase 17 work.

No requested execution approval was rejected in this continuation; there is no currently approval-blocked command. Failures above are actual infrastructure/setup/test results, distinct from historical Phase 16.1 approval restrictions.

## Final checklist

- [x] Node 24 typecheck; whitespace; disposable and main optional Search Compose validation.
- [x] Scoped empty-index cleanup regressions exercised successfully in the intermediate complete Search run; assertions preserved.
- [x] Bounded cancellation/redelivery regression passed twice after heartbeat cleanup correction (before final stop-state guard).
- [x] Successful Search teardown in intermediate whole-Search passes and both final failed-setup cleanup paths.
- [ ] Whole Search passes under final source twice, with zero unexecuted cases and no unhandled errors.
- [ ] Notification/rate-limit/checkout/refund and all existing-service regression under final source.
- [ ] Full regression Run 1 and Run 2.
- [ ] Zero skipped/unexecuted cases in final paired focused verification (80 unexecuted per run).
- [x] Owned disposable projects cleaned; development data/defaults/existing work preserved.
- [x] No commit, push or Phase 17.

Final decision: **Phase 16.2 INCOMPLETE; Phase 16 is not fully verified.** Confirmed shutdown defect: unbounded cancellation/protocol closure despite a configured shutdown budget. Exact original internal blocking stage and underlying infrastructure latency remain unproven. The final corrections are implemented and statically valid, but further clean runtime verification is necessary.
