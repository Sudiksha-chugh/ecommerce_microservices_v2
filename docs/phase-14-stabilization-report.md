# Phase 14.1 — Integration test stabilization

## Scope and baseline

Phase 14's report and Notification architecture, Vitest configuration, service database fixtures, broker fixtures, process-crash fixtures and Compose definitions were inspected. All earlier staged/unstaged work was retained. Work is limited to this repository; no production business logic, development database migration, default feature activation, commit or push is part of stabilization.

Historical Phase 14 full result: 696 passed, 12 failed of 708. Independent Notifications: 66/66. The older pre-Notification baseline was 642 passed, 2 failed of 644 (Payments provider-I/O transaction and bounded-worker waits). The current full suite contains 710 tests because the final Phase 14 suite added two provider-capability safety cases after the historical full run collected 708.

## Reproduction and classification

An unmodified fresh serial reproduction under host Node 22.23.3 ran **all 710 tests: 709 passed, 1 failed**, in 138.54 seconds. Every one of the historical 12 passed. The new failure was Checkout's `protects lost-response payments, reconciles with the original key and never charges twice`: reconciliation had not produced an inventory-confirm command, and passing the absent command to the handler raised `Invalid event`.

A Node 24.21.0 full run with the previous two-worker configuration reproduced **709 passed, 1 failed**, in 392.40 seconds. The failure was Refund's `reconciles timeout using the same operation without another refund`: expected SUCCEEDED, received REQUIRES_RECONCILIATION. Fixtures loaded before their stabilization edits produced this failure; later-loaded suites could pick up edits made during the run, so this is not presented as a second pristine baseline.

The historical failure categories and their evidence are:

- **Messaging interrupted in-flight publication (1):** passed the pristine reproduction and subsequent full runs. Existing recovery scenario; no new application defect reproduced. Its suite spent 77.68 seconds in the pristine serial run and 370.74 seconds in the two-worker Node 24 run creating/deleting isolated quorum topologies. Broker logs show serialized Raft leader/cluster creation. This is fixture churn and sensitivity to shared infrastructure, not proof of a broken publisher.
- **Checkout RabbitMQ end-to-end completion (1):** passed the pristine reproduction; reproduced during the two-worker repeat after the first fixes (33.22 seconds, timed out). Classified as shared test-infrastructure readiness/recovery sensitivity. Separately, the lost-response batch test exposed a verified due-time fixture race.
- **Refund timeout reconciliation (1):** reproduced under Node 24. A single ProviderClient with a 20 ms deadline was reused for both intentionally timing out the send and checking successful recovery. A slow legitimate lookup correctly returns UNKNOWN; the assertion incorrectly assumes that the intentionally short deadline is a normal recovery budget. This is an existing test-fixture defect, not evidence that an unknown financial result should be rewritten as success.
- **Event-persistence RabbitMQ tests (6):** the historical report records their count but does not retain their individual names. All nine tests in `packages/event-persistence/test/rabbitmq-integration.test.ts` were rerun, with no skips, and passed in the pristine reproduction and the first post-fix full run. Exact retrospective attribution of those six names is unavailable; no invented failure identities are supplied. The coverage includes committed creator recovery, publisher-after-confirm SIGKILL, consumer-before/after-commit SIGKILL, stale publisher takeover, failed-inbox retry and outage recovery.
- **Notification broker readiness tests (3):** historical full failures covered consumer commit-before-ACK recovery, business completion during Notification outage, and least-privilege producer/consumer readiness. All passed independently and in the pristine reproduction. The least-privilege readiness failure reproduced in the two-worker repeat (49.50 seconds). No notification delivery or authorization application defect was demonstrated; this remains a shared-resource fixture issue until the final isolated runs below establish the corrected harness.

The two pre-existing Payments waits were also executed. Their original assertions remain and their fixtures now explicitly control the provider response/due work instead of relying on elapsed sleeps. No test was removed, marked skipped or weakened to get a passing result. No global Vitest or failure-injection timeout was increased. One reconnect wait now uses the existing bounded startup-readiness helper instead of Vitest's implicit one-second default; the consumer-count assertion remains.

## Verified causes, instrumentation and fixes

### Quorum topology churn and file-level contention

Messaging originally created and deleted 50 quorum queues for each of its 21 scenarios: approximately 1,050 queue lifecycles per full run. The fixtures now explicitly select only queues needed by their scenarios: Messaging uses three, event-persistence two, Checkout five, and Refund eight. The shared Messaging API accepts an optional validated queue allowlist, intersects it with service ownership, and rejects registration of an omitted queue. Without this option, all existing production topology behavior remains unchanged. A new ownership/default-registration test verifies that contract. This reduces redundant metadata RPCs as well as creation churn.

BeforeEach also replaced the confirm channel initially opened in BeforeAll without closing that initial channel. The fixture now creates one unique topology per suite, closes its setup channel, stops every manager/process/proxy before purging queues between scenarios, and deletes its own topology at the end. Quorum type, persistence, retry/DLQ, mandatory routing, negative confirm, channel cancellation and crash assertions remain unchanged.

Read-only snapshots showed no broker memory/disk alarms; file descriptors were about 40 of 1,048,576, Erlang processes about 525 of 1,048,576, and only a few test PostgreSQL connections against max_connections 100. Connection/channel exhaustion was not observed. Query/schema identities and queue namespaces are unique. These observations narrow the problem to workload/readiness latency; they do not establish an exact host-level CPU/I/O cause for every historical timeout.

A first two-worker post-fix run passed **710/710 in 38.92 seconds**. Repeating it against the shared local stores failed **3 tests, 707 passed, in 490.07 seconds**: Refund broker end-to-end recovery, Notification least-privilege readiness and Checkout broker end-to-end completion. That repeat is retained as evidence; the first green run was insufficient.

Vitest now serializes test files with maxWorkers 1. Concurrent requests, claims, worker instances and stock/payment races inside the scenarios remain real. An explicit CLI override still permits experimentation with multiple suite workers.

### Persisted retry due times

Checkout's lost-response test now sets its test payment's persisted next_reconcile_at to the database clock before invoking the batch worker, and asserts one candidate was processed. It then preserves the finalized checkout and one-charge assertions. The Payments periodic-worker test also makes its existing pending payment due before starting the worker. This removes dependence on a 10/50 ms wall-clock coincidence, without changing production scheduling or retry semantics.

### Deterministic provider I/O and recovery

The transaction test forwards a real HTTP charge to the independently persisted provider, then holds its HTTP response behind a gate while checking `FOR UPDATE NOWAIT` on the payment. It asserts that the service request has not settled before releasing the gate. The transaction is rolled back in finally and the proxy is closed after draining the request.

Refund timeout/lost-response cases retain the 20 ms failure-injection client, wait for the actual persisted provider operation, and use a separate normal 1,000 ms recovery client (the existing fixture's normal budget). The same provider operation and exactly one refund are still asserted. An accepted operation is never inferred merely from a mock call count.

### Teardown and timeout isolation

A later host-run attempt on fresh stores reported 703 passed and 7 failed in 513.85 seconds. The first partial-refund test timed out; subsequent BeforeEach TRUNCATE operations hit connection timeouts and a deadlock while its asynchronous work continued. Refund fixtures now track and drain creation, delivery, reconciliation and cancellation work before the next reset. This changes cleanup, not financial assertions or business lock behavior.

Another intermediate host-run attempt reported 701 passed and 10 failed of 711 in 1,319.26 seconds. It ran while stabilization edits were in progress and is not a final frozen-code verification. Its observer completed 1,307 SELECT 1 probes with no errors, but maximum round-trip time was 4,369.70 ms while the maximum parent timer interval was only 1,041.92 ms. The host event loop was responsive; store/network scheduling latency could exceed the fixtures' short I/O budgets. This is direct evidence that fresh volumes alone did not solve the environment problem. No exact CPU/I/O cause is inferred beyond that measurement.

### Disposable infrastructure and diagnosability

`test/environment.ts` lets integration fixtures read generated env files through INTEGRATION_ENV_DIR; without that variable the existing local test files continue to work. Production environment loaders are unchanged. The final full suite has 711 tests: the additional case tests queue allowlist ownership and preservation of default registrations.

`scripts/integration-runner.mjs` starts a uniquely named Compose project with fresh PostgreSQL 17, RabbitMQ 4.2 and Redis 8 on random localhost ports. It provisions only test roles/databases and empty inaccessible database names needed for existing exact permission-denial assertions. It supplies generated env files and runs the unchanged Vitest scenarios in a Node 24 Linux container sharing the stores' network namespace. The test image contains sources and Linux dependencies; its Dockerfile-specific ignore list excludes secrets, local env files, Git metadata and host node_modules. This removes the host-to-Docker hop and keeps test/store clocks and scheduling in the same VM. JSON reports are copied back to the requested host path. Cleanup removes only the generated project and temporary configuration. Schema and role identity guards are preserved. Notifications' generated databases use this fresh cluster too. No development secrets, databases or volumes are copied or reset.

The initial two harness startup attempts failed before any test executed. Captured logs identified `Error when reading /var/lib/rabbitmq/.erlang.cookie: eacces`. The RabbitMQ image account was verified as UID/GID 999. Disposable broker tmpfs storage now has uid/gid 999, mode 0700, and the container runs as that account. This fix is confined to disposable integration/smoke definitions, not the development broker.

Readiness failures include state and messaging counters. `scripts/integration-diagnostics.mjs` records sanitized PostgreSQL waits/connection counts and RabbitMQ alarms, descriptors, channels, queues and pending confirms. It does not print passwords, provider secrets, SQL bodies or customer content. The runner captures its own container startup logs before cleanup if setup fails. It waits for authenticated management HTTP and a real AMQP connection; RabbitMQ's ping alone was observed healthy while management sockets still closed. The first containerized attempt exposed a missing node_modules mountpoint under the read-only snapshot. The experimental final layout puts sources and Linux dependencies in the image, avoiding dependency-volume copy initialization and host source sharing; even that did not eliminate all local VM timing failures.

## Files changed in stabilization

Existing files: `vitest.config.ts`, root `package.json`, README, Notification architecture documentation, `packages/messaging/src/connection.ts` and `topology.ts`;  Auth, Catalog, Cart, Inventory, Orders and Payments integration test files; Checkout, Refund and Notification integration tests; Messaging RabbitMQ/readiness tests; event-persistence setup and RabbitMQ tests. Changes to general service suites are limited to test-env file selection. Earlier phase source changes already present in the workspace are not included as stabilization modifications.

Additional existing changes: `.dockerignore`, `compose.yaml` and the Notification Dockerfile. Compose uses a dedicated built PostgreSQL image rather than executing a host-mounted init script.

New files: `test/environment.ts`, `scripts/integration-runner.mjs`, `scripts/integration-diagnostics.mjs`, `scripts/notification-compose-smoke.mjs`, `infrastructure/docker/compose.integration-test.yaml`, `infrastructure/docker/compose.notifications-smoke.yaml`, `integration-test.Dockerfile` and its Dockerfile-specific ignore file, `notifications-postgres.Dockerfile`, this report, and the compact verification evidence file.

## Node.js 24 verification

Official Node v24.21.0 darwin-arm64 was downloaded into temporary storage and verified against its SHA-256 manifest: bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057. The installed Node 22 runtime was not replaced. Node 24 typecheck passed. Independent Notifications passed **66/66 in 7.24 seconds**. A full Node 24 run passed 710/710 as noted above, including the native Auth password-hashing dependency and real child-process crash cases. The final two full runs both passed all 711 tests. The real Notification image ran Linux Node 24.21.0 and passed the final profile smoke. No Node 24 application incompatibility was identified; Node 22 remains outside the repository's declared engine range.

## Final verification

Final code was frozen for the following checks, using the established per-service test databases, unique schemas and test-only RabbitMQ vhost:

- Node 24.21.0 full regression: **711 passed, 0 failed, 0 skipped**, 25/25 suites, **86.16 seconds**.
- Immediate full repeat: **711 passed, 0 failed, 0 skipped**, 25/25 suites, **68.73 seconds**.
- Independent final Notification run: **66 passed, 0 failed, 0 skipped**, **18.39 seconds**.
- Final Node 24 typecheck and git diff --check: passed.
- Earlier migrations and Phase 12/13/14 reports: checksum-verified unchanged.

Every historical failing suite and both pre-existing Payments waits are covered by both final full runs. No historical failure is claimed resolved merely from a skipped/failed setup. The additional queue-selection guard accounts for test 711. Exact aggregate results and failed test identities from every captured development run are in `docs/phase-14-stabilization-results.json`.

The experimental fully containerized runner is implemented and exercised, but **did not achieve a clean full pass in this environment**. Its bind-source development run had 509 passed, 60 failed, 117 unexecuted after hooks, plus three worker-start errors; its image-source run had 647 passed, 14 failed, 50 unexecuted after a hook. These were automatic consequences of failures, not intentional skip declarations, and are not presented as successful verification. The host established-test-store runs above are the final passing verification. Container-only runs remain a documented limitation; do not treat test:isolated as a proven green CI workflow on this machine.

## Docker Compose smoke test

The smoke runner builds the actual Node 24 Notification Dockerfile and merges the real `notifications` profile with a disposable override. It uses fresh tmpfs PostgreSQL/RabbitMQ, random host ports, generated JWT keys and test credentials. It explicitly migrates only those fresh stores. It checks disabled defaults, authenticated readiness, unauthorized management rejection, restricted broker consumption, signed recipient lookups, persisted delivery, duplicate event/restart recovery, stable provider operation and clean shutdown. Any test-only activation is confined to that generated project and env file. The final smoke run **passed every assertion** with Linux Node **24.21.0**: image builds, fresh test-only migrations, disabled worker/consumer defaults, management authentication, broker readiness, signed recipient lookup, provider acceptance, duplicate/restart recovery, one stable provider operation, zero-exit shutdown and resource cleanup. It uses a 100 ms retry base only in its generated smoke environment so temporary lookup failures can recover within the existing smoke deadline; production backoff remains 30 seconds. No mailbox email was sent.

Verified deployment fixes:

- The host bind-mounted database init script failed with `/bin/sh: bad interpreter: Permission denied` and PostgreSQL exit 126. `notifications-postgres.Dockerfile` copies it into the image with mode 0644 so PostgreSQL sources it; the existing development data volume is preserved in Compose. Only fresh smoke data was initialized.
- The npm/tsx PID 1 wrapper caused the clean-shutdown assertion to fail. Notification Docker CMD now launches `node --import tsx src/server.ts` directly, allowing the existing shutdown handler to receive SIGTERM and exit 0.
- Randomly assigned smoke host ports are refreshed after container restart. Idempotent broker setup uses bounded retry and explicitly closed HTTP connections after observed socket-close races. These are harness fixes, not notification resend policy changes.

All seven smoke attempts are retained in temporary logs; only the seventh is the complete passing result. Failed stages were never represented as passing.

## Limits and safety

Historical individual names for the six event-persistence failures were not preserved in Phase 14's saved report; their entire nine-test suite has been covered. Prior two-worker shared-store failures are not erased by later green runs. tmpfs stores verify database transactions and worker/consumer restarts, not physical host power-loss durability or a production multi-node broker. Real SMTP delivery remains outside Phase 14.1. No previous-project container was stopped or changed. Development data and default checkout/refund/notification flags are preserved. No commit, push or later-phase implementation.

## Remaining limitations and reproduction commands

Run the verified local workflow with Node 24 and the established isolated test databases/vhost: `npm run notifications:test:up`, `npm test -- --silent`, `npm run test:notifications`, then `npm run notifications:test:down`. `npm run notifications:smoke` is the passing fully disposable profile check. `npm run test:isolated -- --silent` is an experimental alternative; its container-only full-suite results on this Docker VM remain non-green as detailed above.

Docker reported 10 CPUs and about 7.75 GiB memory. No memory/disk alarm, descriptor exhaustion or PostgreSQL max-connections exhaustion was observed. Timing probes recorded multi-second store round trips and occasional VM/worker-start failures. Two final local full passes demonstrate improvement, not proof that arbitrary host/VM pauses can no longer affect short fixture I/O deadlines. Restarting Docker or changing other projects' resources was outside the authorized safety scope and was not done. No permanent host power setting was changed; temporary idle-sleep assertions ended with their commands.

Optional Bugbot review could not run because its specialized subagent tool was unavailable; no independent review pass is claimed. No source event contracts, financial business transitions or existing migrations were changed in stabilization. Default checkout, refunds and notifications remain opt-in. Only disposable projects and generated test schemas/roles were cleaned. Work stops after stabilization.
