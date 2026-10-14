# Phase 12 checkout

## Architecture and reuse

Gateway forwards customer authorization and Idempotency-Key to Orders. Orders authenticates the JWT, reads that customer's Cart, fetches each Catalog price and builds the immutable item snapshot. POST /orders retains its Phase 7/11 behavior. POST /checkout adds a Saga and signed reservation command to the same order/item/outbox transaction. A replay of a legacy order key returns 409 instead of retroactively inventing a Saga.

Orders orchestrates; Inventory reuses the existing sorted stock locking and all-or-nothing reservation engine with a caller-owned transaction client. Payments reuses payment intent uniqueness, the original provider key, attempts, leases and provider reconciliation. RabbitMQ delivery, retry/DLQ infrastructure, publisher confirms, transactional inbox and outbox workers are reused.

## API

- POST /checkout: authenticated, empty JSON body, required Idempotency-Key. Returns 202 with orderId, sagaId and status, plus a status Location.
- GET /checkout/:orderId/status: owner only. Returns orderId, sagaId, state, orderStatus and updatedAt. Other customers receive 404.
- POST /checkout/:orderId/retry: owner only, empty body. Schedules only INVENTORY_PENDING, COMPENSATION_PENDING or INVENTORY_CONFIRMATION_PENDING. Payment and manual-review states return 409. It never directly calls a provider.

No public endpoints publish internal commands. Existing Inventory and Payments administrative endpoints retain admin authorization. Status responses exclude provider credentials, provider payment references and signing secrets.

## States and audit

Allowed transitions are defined in `apps/orders-service/src/saga/state-machine.ts`:

- CREATED → INVENTORY_PENDING
- INVENTORY_PENDING → INVENTORY_RESERVED → PAYMENT_PENDING
- INVENTORY_PENDING → FAILED (no payment command)
- PAYMENT_PENDING → PAYMENT_RECONCILIATION_REQUIRED
- PAYMENT_PENDING or PAYMENT_RECONCILIATION_REQUIRED → PAYMENT_SUCCEEDED → INVENTORY_CONFIRMATION_PENDING
- INVENTORY_CONFIRMATION_PENDING → COMPLETED (order CONFIRMED)
- PAYMENT_PENDING or PAYMENT_RECONCILIATION_REQUIRED → COMPENSATION_PENDING
- COMPENSATION_PENDING → COMPENSATED (order FAILED)
- INVENTORY_CONFIRMATION_PENDING → MANUAL_REVIEW_REQUIRED (order remains PENDING)

Intermediate states and every meaningful transition are audited even when two transitions share one transaction. Terminal states have no automatic outgoing transitions. Saga updates, order status changes, transition history, inbox receipt and next command commit together. Unknown Saga outcomes are classified and inboxed. Mismatched operation IDs, ownership, reservation/payment linkage, producer or correlation are rejected. Stale and out-of-order outcomes are classified without changing state; recovery reissues safe commands to obtain a fresh authoritative response. Success cannot be overwritten by stale failure.

## Versioned contracts

All envelopes carry eventId, eventType, eventVersion=1, occurredAt, producer, correlationId, causationId and a required-by-Saga-consumers HMAC signature. The generic validator continues accepting unsigned legacy Phase 10 events. Payload schemas are strict Zod objects; extra fields are rejected.

Commands have routing keys:

- inventory.reserve.requested.v1
- payment.process.requested.v1
- inventory.confirm.requested.v1
- inventory.release.requested.v1

New responses use the `checkout` namespace to preserve existing Phase 10 payload contracts:

- checkout.inventory.reserved.v1
- checkout.inventory.reservation_failed.v1
- checkout.inventory.confirmed.v1
- checkout.inventory.released.v1
- checkout.inventory.confirmation_failed.v1
- checkout.payment.succeeded.v1
- checkout.payment.failed.v1
- checkout.payment.reconciliation_required.v1

Every Saga payload includes sagaId, orderId, userId, reservationOperationId and paymentOperationId. Reserve adds items; subsequent operations include reservationId (the stable reservation-group operation ID; item rows retain their existing IDs). Process adds authoritative amountPaise and INR currency. Payment results include paymentId; success also includes amount/currency. The Saga validates the successful amount against the persisted order. Distinct transport retries keep the same operation IDs and original correlation. HMAC producer validation precedes inbox acceptance.

## Reservation expiration and compensation

Inventory writes checkout_hold=true in the same transaction as reservation, Saga ownership linkage, inbox receipt and response outbox. The expiration worker excludes held groups; finish checks the hold instead of the elapsed TTL. Protection does not rely on timely lease renewal. A stale Saga cannot touch an unrelated group: sagaId, userId, orderId, both operation IDs and reservationId must match. Legacy reservations cannot be adopted. Admin HTTP finish cannot bypass the Saga hold.

A definitive payment decline emits release. Inventory commits stock release and its outbox event atomically; only the release outcome marks compensation complete. Failed release attempts roll back, remain pending and can retry. Unknown payments keep their hold. After success, confirmation consumes stock; Orders confirms the order only after Inventory's confirmation response. Invalid confirmation after payment escalates to manual review, without order failure or stock release.

## Payment processing and reconciliation

Payment command acceptance commits inbox, intent and durable work record in one transaction. No provider call occurs there. A worker commits the existing payment claim, then calls the provider, then persists fenced outcome and signed outbox together. If killed after provider success, an expired PROCESSING lease is recovered by lookup using the original attempt request ID. The existing reconciliation worker also publishes outcomes atomically when Saga activation is enabled.

Unknown lookup results remain REQUIRES_RECONCILIATION in Payments and PAYMENT_RECONCILIATION_REQUIRED in Orders. No new charge key or attempt is generated. Definitive results resume the Saga. A retry command may regenerate a definitive outcome if its original outbox needs attention, but cannot create a second charge. There is no age-based policy that assumes failure. Manual review is currently limited to a definitive paid-but-unfulfillable condition.

## Recovery and observability

Orders claims due rows with SKIP LOCKED, a 30-second lease and random claim token; final recovery transactions require the live matching token and lock the row. Claims contain no network work. Recovery writes a fresh transport envelope to outbox, with unchanged business IDs. Backoff starts at 30 seconds and caps at 15 minutes, with eight automatic command retries. Exhaustion sets RECOVERY_EXHAUSTED and leaves the actual state intact for operators. A safe customer retry can reset that budget for inventory and compensation states only.

Structured transition logs include Saga/order/correlation/event/causation/operation IDs, states and retry count. They explicitly report transition_pending_commit, so logs cannot be mistaken for durable state after a rollback. Existing inbox/outbox logs report duration and committed delivery outcomes. The Orders worker logs state counts, stalled counts and oldest age every five seconds. Durable transition rows are authoritative.

## Local operation

Do not reset databases. Copy `.env.checkout.example` to a gitignored `.env.checkout`, set three distinct random signing keys (at least 32 characters each), and enable messaging with diagnostics disabled. Keep each service's dedicated MESSAGING_URL in its service env file; do not share a broker role. Service processes must receive only appropriate broker credentials. The local signing-key trust model is described in ADR 010.

Run `npm run rabbitmq:provision` to apply updated topic permissions while preserving messages. Apply `orders:migrate`, `inventory:migrate` and `payments:migrate` against the configured service databases. These are additive version-controlled migrations; existing applied files are unchanged. Migration 003 creates Saga/inbox tables in Orders, hold/outbox fields in Inventory, and processing-intent/outbox fields in Payments.

Start Catalog, authenticated Cart and the existing mock provider as before. Run in separate terminals:

```sh
npm run dev:checkout:orders
npm run dev:checkout:inventory
npm run dev:checkout:payments
npm run dev:gateway
```

Saga-enabled processes run their own outbox workers. The standalone Phase 11 Orders outbox worker can coexist safely through existing claims. Compose remains the infrastructure-only Postgres/Redis/RabbitMQ stack; no new service or database is introduced. Production orchestration and refunds are outside Phase 12.

## Testing and failure injection

```sh
npm run typecheck
npm run test:checkout
npm test -- --maxWorkers=1
npm run test:messaging -- --maxWorkers=1
npm run test:event-persistence -- --maxWorkers=1
```

Tests use only `*_test_db` roles, unique schemas, and namespaced queues in `commerce_test`. Provider tests reuse the existing durable mock provider with a unique schema in mock_provider_test_db. No development business tables are truncated or migrated by these tests.

Dependency-injected hooks are only supplied by tests, not public request fields or production environment toggles. Inventory exposes before_commit/after_commit hooks; Orders recovery exposes after_claim/before_recovery_commit hooks. Crash fixtures kill real subprocesses at these boundaries and after a real provider charge. Assertions inspect actual persisted stock, inbox, outbox, Saga, payment and provider records after restart/redelivery. Tests also exercise duplicate commands, state ordering, rollback, last-unit contention, TTL safety, compensation, protected admin finish, JWT ownership and Gateway forwarding. RabbitMQ checkout tests use actual broker delivery and an unavailable publisher followed by recovery. Existing Phase 9–11 suites cover publisher-after-confirm crashes, ACK windows, retry/DLQ and connection recovery.

## Operator limits

Unknown payments may retain stock indefinitely. Publication and recovery exhaustion require operator inspection; do not release a hold because it is old. Inspect checkout_saga_transitions, Saga last_error and service outbox NEEDS_ATTENTION records. The existing Orders outbox requeue CLI remains available; Inventory and Payments outboxes can be requeued through the shared OutboxRepository by an authenticated operator workflow (no new public endpoint). Review a paid confirmation failure manually until Phase 13 supplies a safe refund policy. There is no automated refund, manual-resolution API, Grafana integration or production key-management system in this phase.

## Phase 13 extension

[Durable refunds and compensation](refund-compensation.md) add cancellation/refund states to the same Saga behind a separate REFUNDS_ENABLED opt-in. Signed definitive impossible-fulfillment evidence can initiate a refund; generic confirmation failure continues to require review. Existing Phase 12 behavior is preserved when refunds are disabled. See the Phase 13 document for migrations, operator policies and inventory restoration semantics.
