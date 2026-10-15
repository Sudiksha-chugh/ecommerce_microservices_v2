# Phase 12 implementation report

## 1. Baseline and repository audit

The working tree already contained uncommitted Phase 9–11 changes. They were preserved; no reset, checkout, staging, commit or push was performed. The audit inspected Orders pricing/idempotency/migrations, Inventory authorization/reservation/expiration, Payments claims/provider/reconciliation, messaging contracts/topology/permissions, outbox/inbox, Compose and isolated-test infrastructure.

Initial `npm run typecheck` passed. The initial sandboxed test run reported 72 passed, 83 failed and 403 skipped because local HTTP listeners and PostgreSQL/Redis/RabbitMQ connections were blocked. The unsandboxed concurrent run reported 553 passed and five failures: Inventory contention, two PostgreSQL/RabbitMQ recovery timeouts, and two migration-count assertions. That run overlapped the addition of migration 003, so the migration-count failures were introduced by this work and the run is not a clean pre-change baseline. The assertions were updated for three migrations. Sequential verification of the existing suites then passed all 558 tests. Final normal-concurrency verification passed all 586 tests.

## 2. Existing code reused

- Authenticated Orders cart retrieval, Catalog price lookup, safe money calculation, immutable item snapshots and user-scoped idempotency.
- Inventory's existing atomic reservation/finish engine and sorted stock locking; methods now accept the inbox transaction client.
- Payments' original provider client/mock provider, durable attempts, uniqueness, fenced claims and reconciliation. No new payment engine or mock provider was added.
- Phase 10 broker recovery, confirmed publication, manual ACKs and retry/DLQ machinery.
- Phase 11 InboxProcessor, OutboxRepository, OutboxWorker and transaction helpers.

## 3. Files created in Phase 12

- `.env.checkout.example`
- `apps/orders-service/migrations/003-checkout-sagas.sql`
- `apps/orders-service/src/saga/state-machine.ts`
- `apps/orders-service/src/saga/repository.ts`
- `apps/orders-service/test/checkout.test.ts`
- `apps/orders-service/test/checkout-crash.ts`
- `apps/inventory-service/migrations/003-checkout-holds.sql`
- `apps/inventory-service/src/checkout-consumer.ts`
- `apps/payments-service/migrations/003-checkout-intents.sql`
- `apps/payments-service/src/checkout-consumer.ts`
- `packages/messaging/src/saga-security.ts`
- `packages/event-persistence/src/poll-worker.ts`
- `docs/checkout-saga.md`
- `docs/adr/010-durable-orchestrated-checkout-saga.md`
- `docs/phase-12-report.md`

## 4. Files modified by Phase 12

- `.gitignore`, `README.md`, `package.json`
- `apps/api-gateway/src/app.ts`
- `apps/orders-service/src/app.ts`, `order-repository.ts`, `order-service.ts`, `server.ts`
- `apps/orders-service/test/orders.test.ts`
- `apps/inventory-service/src/inventory-repository.ts`, `server.ts`
- `apps/inventory-service/test/inventory.test.ts`
- `apps/payments-service/src/payment-repository.ts`, `server.ts`
- `apps/payments-service/test/payments.test.ts`
- `packages/contracts/src/index.ts`
- `packages/messaging/src/contracts/events.ts`, `contracts/envelope.ts`, `connection.ts`, `topology.ts`, `index.ts`
- `packages/event-persistence/src/event.ts`, `index.ts`
- `infrastructure/rabbitmq/provision.py`
- `docs/event-contracts.md`

Other modified/untracked files shown by git status predated this work. Existing applied migrations 001/002 were not changed. No dependency was added; Phase 12 did not modify the lockfile or Compose infrastructure.

## 5. Database migrations

Orders 003 adds checkout_sagas, indexed/ordered checkout_saga_transitions and an inbox, extends order statuses, and narrows the original order-created outbox uniqueness index to order.created while permitting transport retries. Inventory 003 adds its outbox, durable holds and immutable Saga/user/operation/correlation linkage. Payments 003 adds its outbox and durable command/intents table. The migrations were exercised only in unique test schemas. Development databases were not migrated or reset.

## 6. Saga state machine

The success path is CREATED → INVENTORY_PENDING → INVENTORY_RESERVED → PAYMENT_PENDING → PAYMENT_SUCCEEDED → INVENTORY_CONFIRMATION_PENDING → COMPLETED. Inventory failure reaches FAILED without a payment command. Definitive payment failure enters COMPENSATION_PENDING and reaches COMPENSATED only after release. Ambiguity enters PAYMENT_RECONCILIATION_REQUIRED. Paid confirmation failure enters MANUAL_REVIEW_REQUIRED and leaves the order PENDING. Row locks, operation validation, transactional inbox and durable transition sequencing protect state changes. All allowed transitions are documented in checkout-saga.md.

## 7. Checkout API

Gateway exposes authenticated POST /checkout (202), GET /checkout/:orderId/status and POST /checkout/:orderId/retry. Identity comes from JWT context; prices come from Catalog. Status/retry is owner-scoped. Retry accepts only safe inventory/compensation states and cannot issue a new logical charge. Legacy /orders behavior is preserved; a legacy order idempotency key cannot be converted into a Saga on replay.

## 8. Inventory integration

Commands and ownership are validated before mutation. The inbox receipt, existing reservation engine, durable hold/linkage and signed response outbox share one transaction. Expiration excludes held reservations; linked confirmation remains safe after TTL. HTTP admin finish cannot bypass a hold. Confirmation and release reuse the existing engine with the same local transaction client.

## 9. Payments integration

Acceptance persists inbox, existing payment intent and durable command together. A worker executes the original fenced claim and provider operation outside a database transaction. Provider outcomes and response outboxes commit together. Stable operation IDs map to one payment and one original provider request ID. Distinct transport retries can regenerate outcomes without charging again.

## 10. Compensation

A definitive failure requests release and waits for Inventory's committed release outcome. Rollbacks and interrupted compensation remain pending. A paid confirmation failure never automatically releases stock or marks the order FAILED. Refunds are excluded.

## 11. Reconciliation

Lost-response/unknown outcomes preserve payment and provider request IDs. Existing provider lookup resumes the Saga on verified success/failure. Unknown remains unresolved with protected stock and no second charge. Recovery exhaustion does not imply payment failure.

## 12. Recovery worker

Orders uses SKIP LOCKED claims, 30-second leases and fenced final transactions. Safe retries retain business IDs, use fresh transport IDs and apply exponential backoff capped at 15 minutes, with eight automatic retries. Exhaustion records operator attention without inventing a terminal outcome. Payments' existing reconciliation worker and durable intent worker recover provider operations independently. Each enabled service runs its existing shared outbox publisher.

## 13. Authorization

Customer JWT authentication and existing administrative endpoints remain intact. Broker provisioning restricts command/outcome publishing per service role. Saga consumers additionally verify HMAC-signed strict envelopes, expected producer, operation linkage, ownership and correlation. The local symmetric-key design trusts all three service processes; it is not isolation against a compromised service holding verification secrets. There are no public command publishing endpoints or provider secrets in status responses.

## 14. Crash-recovery results

All checkout crash scenarios passed with real PostgreSQL state and real SIGKILL subprocesses: committed Orders creation, Inventory before/after commit, payment provider success before outcome persistence, Saga after claim/before recovery commit, and compensation after release commit. The RabbitMQ checkout test also exercised the committed-consumer-before-ACK window and an unavailable publisher followed by recovery. Existing Phase 11 tests verify publisher-after-confirm and broker redelivery crash windows. Assertions inspect persisted Saga, payment, provider charge, stock, inbox and outbox records.

## 15. Final verification

- `npm run typecheck`: passed.
- Existing regression suites sequentially: 558/558 passed.
- New checkout suite: 28/28 passed.
- Full `npm test -- --silent`: 586/586 passed, 22/22 suites passed, using normal configured concurrency.
- `git diff --check`: passed.

The full run includes real PostgreSQL and RabbitMQ integration, checkout end-to-end, crash recovery, Inventory concurrency, Payments reconciliation, outbox/inbox, broker retry/DLQ and HTTP/security regression. Tests used only isolated *_test_db schemas and namespaced commerce_test queues. No development business-data writes, migration/provision commands, resets, commits or pushes were performed. No writes were made to the previous ecommerce project.

## 16. Remaining limitations and activation

Checkout defaults to disabled. Activation requires service migrations, dedicated RabbitMQ URLs/topic permissions, and three distinct signing keys from the example configuration. No development activation was performed automatically.

Unknown provider outcomes may retain inventory indefinitely. Exhausted outboxes/recovery require operator inspection; safe inventory steps can be rescheduled through owner retry. There is no automated manual-resolution/refund API, production key-management system or Grafana integration. Paid-but-unfulfilled cases remain recoverable/manual until Phase 13. Separate checkout-prefixed response events preserve legacy Phase 10 contracts. Compose remains the existing infrastructure stack.

Implementation and testing stop at Phase 12.
