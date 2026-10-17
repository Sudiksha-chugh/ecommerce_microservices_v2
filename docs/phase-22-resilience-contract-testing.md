# Phase 22: owned fault injection and consumer contracts

## Architecture and reuse

The existing pipeline remains: strict catalog/configuration → owned fixture and healthy baseline → bounded activation → business-state observation → explicit recovery → invariants → verified cleanup → strict evidence report.

`packages/resilience-testing` is a test library. `scripts/resilience-live.mjs` owns the disposable infrastructure; `resilience-matrix.mjs` extends its existing checks. No running chaos service or production fault endpoint was introduced. Existing Phase 22 behavior, the Cart Redis deadline fix, prior tests and event contracts are preserved.

The implementation reuses the actual Express app factories, service migrations/repositories, Saga state machine and participant handlers, inbox/outbox code, publisher confirms, independently persisted deterministic mock payment provider, Elasticsearch external versions, existing isolated integration harness and Phase 17 observability bootstrap/instruments.

## Fault adapters and safety

`OwnedFaultAdapter` uses a strict discriminated configuration:

- **Dependency interruption:** one adapter for PostgreSQL, RabbitMQ, Redis or Elasticsearch. The existing owned-container pause/unpause capability is reused.
- **Process interruption:** terminate, restart or interrupt an explicitly registered Orders, Inventory, Payments, consumer or publisher child.
- **Network fault:** timeout or connection reset on an owned loopback server.
- **Delivery fault:** bounded duplicates, delayed processing or consumer restart on an owned broker/channel.

Configurations cannot contain commands, endpoints, filesystem paths, container names or process IDs. Targets, operations, copy counts, delays and activation durations are bounded. Each activation/recovery/cleanup reinspects ownership, and the underlying Docker/process capability rechecks immediately before mutation. A watchdog requests recovery when the fault budget expires. Recovery and cleanup remain explicit; cleanup is attempted even when restoration fails. Strict adapter evidence records activation/removal times, recovery and cleanup outcomes.

Docker targets require the current random Compose project, owner/run/target labels, exact discovered identity and safe tmpfs mounts. Prefixes alone never confer ownership. Local process/server/channel capabilities use unforgeable in-process receipts tied to the fixture run; serializing and replaying a receipt fails validation. The process supervisor additionally owns the actual `ChildProcess` references and only launches a fixed allowlist of test-worker modes from a fixed script. It never accepts an external PID or command.

All stores and the network are created for `phase22-<24 hex>`, with loopback ports discovered only after ownership validation and test-only credentials. Orders, Inventory, Payments, mock-provider and publisher fixtures use isolated schemas inside the disposable PostgreSQL cluster. They do not share business transactions. No development database, volume, container or network is a target. Store data is tmpfs; there are no development bind mounts or named development volumes. Network deletion requires exact labels and no attached containers.

## Test-hook isolation

The existing constructor hooks are used only inside `resilience-worker.mjs` or `resilience-crash-child.mjs`. The new worker is an explicitly owned IPC child and validates the fixture marker and database identity before executing one allowlisted job. Provider/publisher crash wrappers live only in this test executable. Production service factories, server configuration and endpoints do not import or enable these workers. Subprocess tests prove that ordinary production environment variables, including a fixture-looking marker, cannot activate either worker without its owned IPC launcher.

Before killing/restarting a child, the supervisor validates dependency ownership, its fixture receipt and the exact registered child handle. A child exits if its parent IPC connection disappears, preventing orphan HTTP workers after parent death. No host DNS/firewall settings or unrelated processes are modified.

## Live catalog and required matrix

The four original strict outage scenarios remain: `postgres-owned-outage`, `rabbitmq-owned-outage`, `redis-owned-outage`, `elasticsearch-owned-outage`. Each verifies failure during an actual pause, recovery, persisted-state preservation and exact container cleanup.

The 12 additional matrix cases are:

1. `service-process-restart`: actual Orders Express routing, JWT verification and persisted-order lookup survive an owned server process restart.
2. `network-timeout`: an owned loopback downstream stops responding; Gateway returns a bounded timeout and recovers.
3. `network-connection-reset`: an owned downstream destroys its socket; Gateway reports unavailability and recovers.
4. `duplicate-event-delivery`: six real durable deliveries apply one actual inbox business effect.
5. `delayed-message-processing`: the message remains durable with no early business effect, then processes after the bounded gate opens.
6. `consumer-process-restart-before-ack`: the consumer commits, dies before ACK, restarts and receives real broker redelivery without another effect.
7. `order-commit-before-publisher`: actual order and outbox commit before publisher execution; the committed event is still pending/recoverable.
8. `outbox-process-crash-after-publish`: the publisher dies after broker confirmation and before marking sent; restart publishes the expired claim, with duplicate delivery but one inbox effect.
9. `payment-provider-success-before-persistence`: a real child dies after the fake provider commits success; lookup reconciliation preserves one charge.
10. `refund-provider-success-before-confirmation`: a real child dies after provider refund success; reconciliation preserves one refund.
11. `inventory-concurrent-last-unit`: six real PostgreSQL contenders produce one reservation, followed by idempotent release.
12. `checkout-process-interruption`: Inventory dies after reservation commit, replay deduplicates, a later payment decline produces durable compensation and restores stock once.

Together, these 16 cases cover all 13 required live categories, plus reset, delay and commit-before-publish checks. The nine original business checks also remain. Every completed experiment has its own telemetry record, for 25 records in a successful run. The reports distinguish the 16 fault/concurrency matrix cases from the nine retained boundary/state checks.

## Transaction-boundary evidence

- **Order rollback:** a test-only trigger rejects the actual outbox insertion inside `OrderRepository.create`; neither order nor event commits.
- **Commit before publishing:** the order and its pending outbox row are inspected before any publisher handles that order.
- **Publish before mark:** a separate owned publisher process is SIGKILLed after a real RabbitMQ confirm. PostgreSQL retains the processing lease; after expiry, a new publisher process publishes again and marks the row. Real delivery plus `InboxProcessor` proves one business effect.
- **Payment before local outcome:** the provider has one durable successful charge while Payments remains `PROCESSING`; restart reconciles the original provider request by lookup and becomes `SUCCEEDED`.
- **Reservation before payment decline:** the committed reservation/outcome survives Inventory process death; a definitive later decline creates the release command and reaches `COMPENSATED` with stock restored once.
- **Refund before local outcome:** the provider has one successful refund while the local record is still `PROCESSING`; the restarted worker reconciles the same operation and becomes `SUCCEEDED`.
- **Commit before ACK:** the original consumer dies with a real unacknowledged delivery; a restarted consumer sees `redelivered=true`, ACKs and leaves one effect.

These use actual PostgreSQL/RabbitMQ and persisted fake-provider state. Mocks are not substituted for their transaction/race evidence. Financial identities and lease fencing follow the existing implementation. At-least-once delivery is assumed; exactly-once delivery is not claimed.

## Saga and inventory correctness

The actual happy path is `CREATED → INVENTORY_PENDING → INVENTORY_RESERVED → PAYMENT_PENDING → PAYMENT_SUCCEEDED → INVENTORY_CONFIRMATION_PENDING → COMPLETED`. Definitive payment failure drives `COMPENSATION_PENDING → COMPENSATED`. Unknown payments/refunds remain protected for reconciliation rather than being treated as definitive failures.

The new crash path verifies persisted transitions through the actual `allowed` function, one reservation/outcome, durable release and one stock restoration. Existing real-store crash, compensation, refund-capacity, TTL, last-unit, stale-event and cancellation tests continue to run. Intermediate durable states are valid during recovery; the framework does not assert instant consistency or promise automatic resolution of every manual-review state.

## Consumer mutation contracts

`contracts/http/mutations-v1.ts` adds 18 consumer-owned definitions for actual routes: Orders/Checkout creation; Inventory stock/reserve/confirm/release; payment intent/process/reconcile; refund creation/reconciliation; Cart add/update/remove/clear; Catalog create/update/delete.

Each definition records the method/path, consumer/provider, registry version, request/response schemas, expected statuses, body kind, authentication, authorization and identity semantics. Principal-key creation, order-ID transitions, payment-ID processing, refund-ID reconciliation and operations without a declared idempotency protocol are distinct. Cart additive writes are not falsely declared idempotent. No versioned HTTP URL or header is invented; version 1 denotes the contract registry revision.

Tests invoke actual Express middleware/routing/serialization with controlled business dependencies. They verify valid requests, actual invalid-request rejection, required response fields/types/state values, missing authentication, customer/admin separation, required keys, unchanged key forwarding, error shapes and empty 204 responses. Database/provider idempotency comes from the separate real-store matrix, not from a stable mocked response.

`mutationCompatibility` checks provider responses/errors against consumer expectations and request acceptance in the opposite direction. Negative fixtures prove rejection of missing required fields, changed types, missing authentication, invalid states, changed identity semantics, incompatible errors, newly required request fields and version changes. The conservative checker remains scoped to the repository's schema subset; runtime Zod refinements still require provider validation.

## Event contracts

Existing independently pinned event schemas in `contracts/events/v1.json` remain unchanged. Current providers must retain the pinned wire-input expectations, while actual envelope validation checks event version, producer, enum values, unsupported types/payloads and strict unknown fields. UUID input constraints precede normalization transforms. Notification consumes its existing business events; no new event family or registry service was invented. Contract ownership/versioning is documented in `contracts/README.md`.

## Per-scenario telemetry evidence

`resilience-telemetry.mjs` initializes the **existing Phase 17 bootstrap/SDK** with bounded test exporters and sampling enabled for fixture experiments. It refuses a preexisting SDK and suppresses environment-driven bootstrap initialization, so it does not export to a user-supplied telemetry endpoint. It instruments the fixture's parent PostgreSQL/Redis operations and reuses existing HTTP, Elasticsearch and business instrumentation.

Each experiment records fixture/scenario identity, controller-observed activation/removal timestamps, measured recovery duration, actual exported trace/span references, collected metric observations, invariant results and cleanup. The primary fault adapters mark the actual activation and observed restoration points; the nine retained state checks mark their controlled experiment windows.

The SDK exports real spans to `InMemorySpanExporter` and real metrics to the existing metrics SDK/reader. IDs are read from finished spans. Scenario counters and duration observations come from the SDK, with cumulative sample deltas recorded across experiment windows. Metric labels contain only bounded fault, target, outcome and existing sanitized operation categories. Scenario IDs, order/payment/customer IDs and trace IDs are not metric labels. Trace IDs belong in report references, not labels.

The explicit scope is `phase17-sdk-in-process-export`. This proves actual SDK export/collection during the fixture experiment; it does not claim persistence or querying in Prometheus/Tempo/Grafana, or complete span coverage inside every killed child process. No duplicate telemetry stack was deployed. If lifecycle/trace/metric evidence is missing, or SDK shutdown prevents collection, the record is `unavailable` and full matrix verification cannot pass. Tests cover actual SDK exports, missing lifecycle data, rejected duplicate initialization, failed scenarios, secret-text sanitization, zero IDs and collection after shutdown.

## Invariants and reports

The existing evidence engine distinguishes immediate, eventual and availability checks, with `passed | failed | inconclusive`. Missing/incomplete evidence does not pass, and violation thresholds stay zero. Reusable duplicate-effect, overselling, lost-outbox and Saga-transition reducers remain available.

`completionReportSchema` extends the previous strict report with all 12 unique additional cases and 25 collected experiment records. A passing completion report requires all original outage/state checks, all added matrix cases, verified telemetry, business invariants and cleanup. The bounded schemas restrict collections, IDs, trace references, metric observations and evidence field counts. Results include exact source revision/digest and fixture identity. Previous attempts are preserved under `docs/history/phase22-initial` and `docs/history/phase22-continuation`.

## Recovery and reproduction

Use Node 24, as required by the repository:

```sh
npm run typecheck
npm run test:resilience
npm run test:contracts
npm run resilience:live
INTEGRATION_EXECUTION=host npm run test:isolated -- --reporter=json --outputFile=/tmp/phase22-run1.json
INTEGRATION_EXECUTION=host npm run test:isolated -- --reporter=json --outputFile=/tmp/phase22-run2.json
```

Each isolated harness invocation creates a fresh random project, credentials, stores and service fixture schemas. Final regressions use separate invocations/projects, not a repeat flag over shared stores.

The runner uses `try/finally`, bounded operations, independent recovery/cleanup budgets, pre-mutation ownership checks, watchdog restoration, owned-child teardown and exact container/network removal. SIGINT/SIGTERM stop new work and enter recovery; missing telemetry during SDK shutdown is explicitly unavailable. SIGKILL/host/daemon failure may still require manual recovery:

```sh
node --import tsx scripts/resilience-recover.mjs <24-hex-run-id>
```

This accepts a run token, never an arbitrary container ID, endpoint or command. It validates the current run/owner/project, allowlisted services, mounts and network membership before removal. An IPC child exits when its parent disconnects. No global prune/down command or development-volume deletion is needed.

## Verification scope and limitations

Current results, commands, fixture IDs, source manifest, counts, prior failures and cleanup are recorded in `phase-22-verification-report.md` and `phase-22-verification-results.json`. Historical counts are not evidence for new source.

The deterministic fake provider is not a real financial provider; no real payments/refunds occur. Fixture schemas share a disposable cluster without sharing transactions. Trace evidence is local SDK export, not remote backend persistence. Controlled loopback timeout/reset is not a production network partition or host DNS experiment. The runtime cannot undo arbitrary uncooperative third-party work; the provided capabilities use bounded I/O, registered handles, watchdogs and manual recovery where necessary. These scope limits do not imply exactly-once delivery, universal schema compatibility or production readiness.
