# Phase 22: resilience and consumer contracts

## Architecture and existing components

Scenario catalog → strict runtime validation → fixture ownership → healthy/seeded preconditions → bounded fault → dependency/business observation → recovery → invariant evaluation → verified cleanup → bounded JSON report.

`packages/resilience-testing` is a test library, not a running service. The live controller is `scripts/resilience-live.mjs`. Runtime inputs cannot contain commands, container IDs, endpoints or paths. There is no production chaos endpoint. The library accepts trusted, cancellation-aware controllers; arbitrary code execution through untrusted scenario input is not supported.

Reused components include Express app factories, shared HTTP interfaces, Zod event/envelope validators, actual service migrations and repositories, `InboxProcessor`, leased `OutboxWorker`, the durable checkout Saga, deterministic PostgreSQL-backed mock payment provider, external-version Elasticsearch writes, existing dependency telemetry, and the existing isolated regression harness. No Pact/registry service or payment integration was added.

## Blast radius and fixture ownership

Each live run creates `phase22-<24 hex>` with a fixture network, four isolated containers and test-only credentials. Stores use container-scoped tmpfs; no development or named data volumes are attached. Every target must have a 64-hex Docker identity, current Compose project, owner marker, run token, allowlisted target and only tmpfs mounts. Names alone confer no capability. Resource IDs and loopback ports are discovered from that generated project; there is no infrastructure endpoint override.

Before pause, unpause, removal and recovery the runner reinspects ownership. A rejected identity fails closed. Network deletion requires exact project/run/owner labels and no attached containers. Partial-startup cleanup discovers only the current generated project and reinspects each target. Existing projects and development worktrees are never fault targets. The suite never invokes prune, global stop, host firewall changes or development migrations.

The live fixture uses separate Orders, Inventory, Payments and provider schemas inside its disposable PostgreSQL cluster. These are isolated test schemas, not a claim of cross-service transaction atomicity. Production still has its existing database-per-service architecture.

## Scenario catalog

The strict shared catalog contains `postgres-owned-outage`, `rabbitmq-owned-outage`, `redis-owned-outage`, and `elasticsearch-owned-outage`. Each pauses its exact owned dependency, exercises a bounded operation, restores it, inspects persisted state, verifies recovery, and removes the exact container. Each has healthy/owned/seeded preconditions, a 5-second fault/observation budget, a 20-second execution budget, recovery and cleanup actions, expected behavior and invariant definitions.

Additional live checks have stable IDs in the strict aggregate report:

- `postgres-order-outbox-atomic-rollback`: trigger failure at the actual order/outbox transaction boundary.
- `postgres-order-concurrent-idempotency`: six concurrent retries, one order and committed outbox event.
- `inventory-last-unit-confirm-retry-release`: six real contenders, one reservation, concurrent confirmation, rejected invalid release.
- `rabbitmq-duplicate-redelivery-consumer-restart`: six durable duplicate deliveries and a channel loss before ACK; actual inbox transaction applies one effect.
- `outbox-confirm-before-mark-ambiguity-restart`: real broker confirms, failed database mark, lease expiry and restarted publisher; duplicate deliveries are expected.
- `elasticsearch-duplicate-and-stale-version`: real writes at versions 2, 2 and 1 retain version 2.
- `payment-ambiguous-success-concurrent-reconciliation`: lost provider response, stable operation, concurrent lookup recovery, one successful charge.
- `refund-ambiguous-success-restart-idempotency`: concurrent intent deduplication, lost response and restarted lookup, one refund.
- `checkout-inventory-process-crash-redelivery-compensation`: owned child SIGKILL after reservation commit, redelivery, payment decline and durable stock release.

These nine checks run assertions against real stores. They are not generic fault-controller adapters for every accepted fault enum. Unsupported combinations must not be represented as executed live scenarios.

## PostgreSQL behavior and transaction boundaries

`OrderRepository.create` begins one transaction containing the order, items, `order.created` outbox and, when enabled, Saga creation/initial command. An outbox insertion failure must roll back the order too. A successful commit leaves durable outbox state. The `(user_id, idempotency_key)` uniqueness mechanism returns the existing order for the same fingerprint and rejects conflicting reuse. Client ambiguity is not proof of rollback; retries must use the same identity.

Inventory locks the reservation request and ordered stock rows within its transaction. Payment provider I/O occurs outside the local outcome transaction; a successful provider call followed by local persistence failure must be reconciled by its existing stable provider request. Refund outcome and compensation crash/disconnection cases are additionally exercised by the existing isolated regression suites. A paused PostgreSQL fixture tests connection/request deadlines and recovery, not every individual instruction boundary.

## RabbitMQ and transactional outbox

Existing consumers implement at-least-once delivery and idempotent business handling. Existing topology has durable quorum queues, publisher confirms, explicit retries/dead-letter handoffs, bounded retry delays and retained exhausted work. The new low-level live delivery check uses its own durable test queue and the actual inbox processor. It does not replace the existing topology/DLQ tests.

Outbox claims commit before publication. Publishing then losing the mark can duplicate delivery; expired leases make the row eligible again. The live suite verifies this with a real confirm channel and a controlled mark failure. The existing regression verifies rollback/commit, broker outage, publication retries, poison contracts, process crashes, lease fencing and bounded exhausted-work retention. No exactly-once delivery guarantee is claimed.

## Checkout failure matrix

The actual state path is `CREATED → INVENTORY_PENDING → INVENTORY_RESERVED → PAYMENT_PENDING → PAYMENT_SUCCEEDED → INVENTORY_CONFIRMATION_PENDING → COMPLETED`.

- Before/during reservation: durable initial command is retryable; definitive stock failure moves to `FAILED`.
- Reservation committed, consumer dies before ACK: replay must preserve one reservation and one outcome. The new live child exercises this point.
- Payment response unknown: `PAYMENT_RECONCILIATION_REQUIRED` protects stock while provider lookup determines outcome; uncertainty is not failure.
- Definitive payment failure: `COMPENSATION_PENDING → COMPENSATED`; release is idempotent and the order becomes `FAILED`.
- Payment succeeded, confirmation delayed: retry the durable confirmation. Do not refund solely because delivery is delayed.
- Durably impossible fulfillment: existing refund/compensation flow distinguishes it from delay; unresolved fulfillment may require `MANUAL_REVIEW_REQUIRED`.
- Cancellation: actual states include `CANCELLATION_REQUESTED`, `CANCELLATION_PENDING`, `REFUND_PENDING`, `REFUND_RECONCILIATION_REQUIRED`, `INVENTORY_RELEASE_PENDING`, `CANCELLED`, and `CANCELLATION_FAILED`.
- Refund or release interruption: durable operations and provider identities resume, retaining unknown financial capacity. Existing SIGKILL tests cover before/after intent, provider, outcome and compensation commits.

Intermediate states are valid while recovery is pending. The production Saga has bounded retry/manual-review paths, so universal eventual automatic completion is not an invariant. The new live failure path asserts every persisted transition using the actual `allowed` function.

## Financial and inventory invariants

Payment/reconciliation, refund/provider and order creation use their own existing identities. The suite never sends real funds. Provider charge and refund rows are independently persisted and inspected; success claims require definitive stored states, with exactly one successful financial effect for the tested operation. Concurrent financial capacity and before/after provider-crash behavior are retained in the existing regression.

Inventory assertions require nonnegative stock, `available = total - reserved`, no overselling, stable ownership and valid terminal transitions. Six real concurrent PostgreSQL transactions compete for the last unit; repeated confirmation cannot decrement twice. The checkout crash/compensation path restores stock once. Existing regression covers TTL expiry, release races, cancellation after confirmation and verified-refund restoration.

## Redis policies and the discovered Cart fix

Cart has no authoritative fallback when storage is unavailable: it must return 503, never fabricate an empty cart. Redis reconnection uses the existing bounded backoff and disabled offline queue. Rate-limiter failure policy is configured per existing gateway policy (`open` or `closed`); outage behavior is not generalized to every Redis use. Authentication and authorization middleware remain independent requirements.

The first pause experiment found that the installed Redis client's command timeout ceased protecting commands once written to an established socket. `CartRepository.execute` now bounds the entire response wait. A unit test reproduces a never-settling reply; real paused Redis verifies failure and post-recovery preservation. A timed-out mutation may have executed remotely: the deadline does not make Cart writes transactional or automatically retry-safe.

## Elasticsearch recovery

Search unavailability must remain explicit, not return a misleading successful empty page. Catalog committed changes/outbox remain authoritative. Existing projection code remembers latest versions before writing and uses external document versions; the new live check proves stale/duplicate writes cannot replace version 2. Existing integration tests cover inbox-commit ambiguity, missing index/reconciliation, durable rebuild resumption, delayed events, broker disconnect and SIGKILL around alias switching. The outage check preserves the owned index on recovery. No development index is deleted or recreated.

## Network behavior

New tests use real ephemeral loopback HTTP servers for slow/no response, partial response, connection reset, upstream 503, and payment/refund timeout classification. Gateway deadlines cover body reads; one failing request does not launch an implicit retry storm. Provider timeout yields `UNKNOWN`, not an invented failure or success. No host DNS/firewall changes occur. Actual DNS failure and multi-service partition-specific scenarios are not newly verified by this suite. No circuit breaker was added or inferred where none exists.

## Contracts and compatibility

Versioned HTTP expectations are in `contracts/http/v1.ts`; provider tests exercise actual Express routing, serialization, authentication and authorization with controlled business dependencies. They cover Auth, Catalog, Cart, Orders, Payments, Inventory and Search. Read-response expectations and required error shapes are covered; this is not exhaustive request/response coverage for every route and operation.

`contracts/events/v1.json` pins all existing event payloads using input-side JSON Schema, preserving UUID constraints before transforms. Runtime `validateEvent` additionally checks envelope version, producer and strict payload parsing. Notification contracts correspond to the existing business events consumed by Notification, not a newly invented notification-event family.

Required removals, type changes, enum expansion outside consumer expectations, versions, authentication metadata, response shape and unknown-field policies are tested with intentional failures. Optional additions pass for tolerant HTTP consumers; strict event payload additions fail. The conservative compatibility checker is directional and only supports this repository's schema subset; unsupported keywords require exact equality. Cross-field Zod refinements require actual runtime validation, not a universal backward-compatibility claim. Consumer groups in registry metadata describe queue ownership classes rather than new services. See `contracts/README.md` for ownership/versioning.

## Invariant engine and reporting

Invariant results distinguish `passed`, `failed`, and `inconclusive`, with immediate, eventual and operational categories, horizons, evidence and stable failure details. Evidence records count violations; accepted thresholds are exactly zero. Partial, missing, invalid or out-of-horizon evidence never produces a pass. Reusable reducers handle duplicate effects, overselling, lost committed outbox IDs and invalid Saga transitions. IDs remain in test memory, not metric labels.

Reports contain source revision/digest, fixture identity, start/end timestamps, durations, fault category, target category, invariant outcomes and recovery/cleanup evidence. Strict schemas bound identifiers, collections and evidence; forged passing lifecycle reports are rejected. Aggregate live reports require all four unique scenarios, nine unique checks and verified cleanup for a pass. Errors use stable categories without arbitrary exception text in scenario reports. Existing service telemetry is reused; no production instrumentation or high-cardinality Prometheus labels were added. Scenario reports do not establish that traces were persisted to an observability backend.

## Runner deadlines and recovery

Run with Node 24:

```sh
npm run typecheck
npm run test:resilience
npm run test:contracts
npm run resilience:live
INTEGRATION_EXECUTION=host INTEGRATION_REPEAT=2 npm run test:isolated -- --reporter=json --outputFile=/tmp/phase22-regression.json
```

The main runner uses `try/finally`, hard caller deadlines, independent 30-second recovery and cleanup budgets, and ownership revalidation. Total theoretical runner budget is scenario execution plus up to 60 seconds for rescue/cleanup. Fault activation/observation shares the shorter fault deadline. Controllers must honor cancellation, use bounded I/O, and never launch detached side effects; JavaScript cannot forcibly cancel arbitrary third-party code. The provided Docker adapter uses bounded child processes; loss of the Docker daemon can still prevent automatic recovery.

SIGINT/SIGTERM stop new scenario work and enter recovery. SIGKILL, host failure or daemon loss cannot guarantee process cleanup. After an interrupted live run, use the run token from the report/log/labels:

```sh
node --import tsx scripts/resilience-recover.mjs <24-hex-run-id>
```

This command accepts no endpoint or resource ID. It verifies exact project/run/owner labels, service allowlisting, safe mounts, and empty owned networks before removal. If ownership is missing or resources are unexpected, it stops. Resolve Docker availability and inspect the reported fixture manually before retrying. All data is disposable fixture tmpfs. No volumes or broad Compose down/prune are required. Manual cleanup is idempotent; local temporary manifests may remain after an externally killed process and contain only test configuration.

## Verification and limitations

Final commands, digests, counts, failures, category evidence and cleanup are recorded in `phase-22-verification-report.md` and `phase-22-verification-results.json`. Historical Phase 21 counts are not Phase 22 results.

Remaining breadth includes deterministic per-boundary database disconnections for every checkout/payment/inventory operation, full consumer expectations for all HTTP mutation routes, dedicated DNS/partition adapters, and automatic per-scenario trace/metric backend evidence. The enum accepts additional fault categories for trusted adapters; that alone does not implement or verify those categories. Actual distributed evidence comes from the live suite and existing isolated regression, not mocked unit tests.
