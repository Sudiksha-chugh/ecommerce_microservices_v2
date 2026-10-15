# Phase 13 — durable refunds, cancellation and compensation

## 1. Baseline and repository audit

Before implementation, `npm run typecheck` passed and `npm test -- --silent` passed all **586 tests across 22 suites**, including real PostgreSQL, RabbitMQ, checkout and crash recovery. There were no baseline failures. Implementation did not overlap the baseline run.

The audit read phase-12-report.md and checkout-saga.md and inspected payment schema/state/attempts/provider/idempotency/reconciliation; Orders status/Saga/recovery/idempotency; Inventory confirmation/release/expiration/authorization; contracts/topology/permissions; outbox/inbox; Gateway routes; Compose; migrations and isolated-test setup.

The existing staged/unstaged working tree was preserved. A before-work source hash manifest was used to identify Phase 13-only files and verify unchanged service migrations 001–003 and the Phase 12 report. No reset, staging, commit or push was performed. The previous ecommerce project received no writes.

## 2. Existing code reused

- Existing JWT verification, customer ownership and admin financial authorization.
- Orders’ immutable authoritative snapshot, same Saga row, transition history and fenced recovery worker.
- Inventory stock locking and all-or-nothing release engine, transactional holds and ownership linkage.
- Existing captured payments, attempts, provider client, durable mock provider and payment reconciliation.
- Existing InboxProcessor, OutboxRepository, OutboxWorker, signed envelope validation, broker retry/DLQ, confirms and connection recovery.

No new mock provider, application mutex, distributed transaction, dependency or infrastructure service was introduced.

## 3. Files created

- `apps/payments-service/migrations/004-refunds.sql`
- `apps/payments-service/src/refund-state-machine.ts`
- `apps/payments-service/src/refund-repository.ts`
- `apps/payments-service/src/refund-service.ts`
- `apps/payments-service/src/refund-consumer.ts`
- `apps/payments-service/src/mock-provider/refunds.ts`
- `apps/payments-service/src/mock-provider/migrations/002-refunds.sql`
- `apps/orders-service/migrations/004-cancellation.sql`
- `apps/orders-service/test/refund-compensation.test.ts`
- `apps/orders-service/test/refund-crash.ts`
- `apps/inventory-service/migrations/004-compensation.sql`
- `apps/inventory-service/src/compensation-consumer.ts`
- `docs/refund-compensation.md`
- `docs/adr/011-durable-refunds-and-distributed-compensation.md`
- `docs/phase-13-report.md`

## 4. Files modified by Phase 13

- `.env.checkout.example`, `README.md`, `package.json`
- `apps/api-gateway/src/app.ts`
- `apps/orders-service/src/app.ts`, `errors.ts`, `middleware/authenticate.ts`, `saga/repository.ts`, `saga/state-machine.ts`, `server.ts`
- `apps/orders-service/test/orders.test.ts` (migration count)
- `apps/payments-service/src/app.ts`, `provider-client.ts`, `server.ts`, `mock-provider/app.ts`, `mock-provider/migrate.ts`
- `apps/payments-service/test/payments.test.ts` (migration count)
- `apps/inventory-service/src/checkout-consumer.ts`, `inventory-repository.ts`, `server.ts`
- `apps/inventory-service/test/inventory.test.ts` (migration count)
- `packages/contracts/src/index.ts`
- `packages/messaging/src/contracts/events.ts`, `topology.ts`
- `infrastructure/rabbitmq/provision.py`
- `docs/checkout-saga.md`, `docs/event-contracts.md`

Other modified/untracked files visible in git status predated this work. The lockfile, Compose stack and existing applied service migrations were not changed by Phase 13.

## 5. Database migrations

Payments 004 creates refunds, refund_attempts and ordered refund_transitions, with local payment foreign keys, positive BIGINT amount constraints, unique principal/idempotency and provider operation identities, status/lease/completion constraints and recovery indexes.

Orders 004 extends the existing Saga with cancellation/refund/compensation linkage and states, cancellation idempotency receipts and owner-scoped refund projections. Inventory 004 adds RESTORED, a durable fulfillment barrier and a unique per-order compensation receipt. The mock provider’s additive version-controlled migration adds independently persisted provider refunds.

Tests exercised these migrations only in unique schemas of dedicated test databases. No development migrations, broker provisioning, database resets or business-data changes were performed. Updated services require the new schemas when an operator explicitly chooses to deploy them.

## 6. Refund state machine

REQUESTED → PROCESSING → SUCCEEDED / FAILED / REQUIRES_RECONCILIATION. Reconciliation may resolve definitively or reach MANUAL_REVIEW_REQUIRED after eight unknown observations. Manual review preserves uncertainty and capacity; an admin lookup can resolve it from verified provider evidence. Terminal success/failure cannot be overwritten by stale leases or events.

A workflow request rejected for capacity is recorded durably as FAILED without a provider attempt. This prevents a delayed command from becoming a new refund later when capacity changes. Invalid/missing captured-payment linkage is retained for broker/operator review rather than inventing a financial outcome.

## 7. Refund amount safety

Creation locks the captured payment in PostgreSQL. Every refund except definitive FAILED consumes capacity, including manual/unknown work. Monetary accounting uses BIGINT/BigInt. Currency and capture eligibility are validated. Concurrent different-key requests cannot over-refund; identical retries converge on one refund and conflicting retries return 409. The mock provider independently locks capture and checks capacity.

Full and multiple partial admin refunds are supported. Automatic cancellation currently requires a full immutable-order-amount reservation; prior partial/full admin refunds can block it safely with CAPACITY_CONFLICT instead of issuing another full refund or guessing remaining settlement.

## 8. Provider idempotency

The original provider operation UUID is stored once and remains unchanged across processing, lost responses, restart and reconciliation. The existing provider app exposes refundPayment/getRefundStatus through its client and persists one provider record per operation independently from Payments transactions. Success, decline, temporary failure, timeout, lost response and permanently unknown outcomes use deterministic server-side scenarios.

## 9. Refund reconciliation

Provider calls occur outside PostgreSQL transactions. Expired PROCESSING and ambiguous work use lookup rather than a new refund call/key. Outcomes, attempts, transitions and signed outbox events commit together. Unknown outcomes retain capacity and order/inventory state. Eight unknown observations stop automated lookup and require admin reconciliation; no endpoint can declare an unknown refund terminal without provider evidence.

## 10. Cancellation state machine

Cancellation extends the existing Orders Saga: CANCELLATION_REQUESTED → CANCELLATION_PENDING / REFUND_PENDING → REFUND_RECONCILIATION_REQUIRED if ambiguous → INVENTORY_RELEASE_PENDING → CANCELLED. Definitive refund failure reaches CANCELLATION_FAILED; automatic paid-but-unfulfilled recovery finishes COMPENSATED. Appropriate unresolved states can escalate to MANUAL_REVIEW_REQUIRED.

Customer/admin cancellation is authenticated, owner/role checked, idempotent and row-locked against checkout/recovery. A possibly delivered payment command is resolved before refund/release; it is never assumed absent. Delayed inventory/payment outcomes cannot resume normal checkout after cancellation intent. The order remains accurate until required compensation commits.

## 11. Inventory compensation

Active reservations use the existing release engine. Confirmed consumption is restored once only with a verified-refund operation in the authenticated command. Expired/released/restored groups are classified without another stock mutation. Stable compensation IDs, unique per-order receipts, stock locks, transactional inbox/outbox and the fulfillment barrier prevent double restoration, unrelated-order mutation and late confirmation. Constraints preserve nonnegative stock; failed stock updates roll back and leave compensation pending.

## 12. Saga integration and invariants

Orders waits for definitive refund success before compensating paid inventory, and for Inventory's committed response before marking CANCELLED. Duplicate/stale events cannot repeat refund/stock effects or overwrite terminal financial outcomes. Refund/payment/order/customer/amount/currency/operation/correlation linkage is validated against persisted state.

Automatic paid-but-unfulfilled refund requires a signed Inventory event backed by locked, definitive impossible-fulfillment state and a durable confirmation barrier. Temporary delay or the older unknown confirmation failure retains recovery/manual review. Order-finalization rollback is recovered by event redelivery, not automatic refund.

Standalone admin refunds are projected for their owning order but do not automatically cancel it or alter stock. Paid orders remain visible and accurate when refunds fail or remain unknown.

## 13. Recovery workers

Refund workers claim REQUESTED, expired PROCESSING and ambiguous rows with SKIP LOCKED and leases. Tokens fence outcome persistence. Backoff starts at 30 seconds and caps at 15 minutes; repeated uncertainty escalates after eight observations. The existing Orders worker recovers refund/cancellation/compensation commands using unchanged operation IDs and bounded retries. Existing outbox workers recover committed publication. No provider call is made within a long-running local transaction.

Structured refund/outbox/Saga logs and state/age metrics expose requests, outcomes, reconciliation, cancellation/compensation backlogs and operator attention. Pre-commit logs explicitly identify pending_commit. No Grafana integration is added.

## 14. Authorization and security

Gateway exposes cancellation and refund routes with existing forwarding conventions. Customers may cancel their own eligible Saga orders and view their own statuses. Admins can cancel eligible orders, initiate explicitly authorized full/partial refunds, inspect and reconcile unresolved operations. Financial mutations remain admin-only; cancellation cannot accept customer-selected amounts. Strict schemas reject extra fields and responses exclude provider credentials/operation metadata.

Dedicated broker permissions and HMAC producer validation supplement each other. Consumers validate expected payment/Saga/operation/amount/currency/ownership linkage; exact inbox redelivery and distinct transport retries are both safe. Static broker policy regex checks verify allowed refund/compensation routes and that Inventory/Payments cannot publish Orders refund commands. The local symmetric-secret trust boundary still assumes trusted service processes.

## 15. Crash-recovery and failure-injection evidence

Real PostgreSQL/provider state and SIGKILL subprocess tests cover refund intent before/after commit, provider refund success before DB update, outcome transaction before/after commit, accepted refund command before ACK, Orders refund outcome before ACK, cancellation/recovery-claim restart, and Inventory compensation before/after commit.

The real RabbitMQ flow covers publisher unavailability followed by recovery, duplicate commands/outcomes and consumer commit-before-ACK retry. PostgreSQL tests cover real trigger rollback, disconnected-client recovery and terminating the actual reconciliation outcome transaction before commit. Recovery assertions inspect refunds, attempts, provider refunds, stock, receipts, outboxes and Saga state. No shared development database/broker was stopped to simulate failure.

## 16. Verification results

- Baseline `npm run typecheck`: passed.
- Baseline normal-concurrency `npm test -- --silent`: **586/586 tests**, 22/22 suites passed.
- Initial Phase 13 integration suite: 49/49 passed; expanded suite and full regression: 642/642 passed before the final two tests.
- Final normal-concurrency run: 643/644 passed. The existing Phase 9 provider fan-out response-consistency assertion failed (two distinct responses from ten calls with a one-second client deadline). It was not a Phase 13 failure and does not demonstrate duplicate provider charges; the timeout/contention explanation is an inference from the fixture and local load.
- Final `npm test -- --silent --maxWorkers=1`: **644/644 tests**, 23/23 suites passed, including all **58 Phase 13 tests** and the previously failing provider test. No assertion/deadline was weakened.
- Final `npm run typecheck`: passed.
- `git diff --check`: passed.
- Broker policy regex checks and unchanged-source/migration hash checks: passed.

Sequential verification is the clean final full result. The observed parallel fixture failure is retained here as a validation limitation rather than claiming a consistently clean parallel run.

The Phase 13 suite covers full/partial/multiple refunds, over-refund and concurrent capacity, idempotency conflicts, provider decline/timeout/lost/unknown results, manual review and lookup resolution, stale lease fencing, durable rejection, cancellation at inventory/payment/paid boundaries, duplicate/concurrent cancellation, delayed success/confirmation, inventory release/restoration, paid-but-unfulfilled outcomes, API ownership/admin authorization, Gateway forwarding and real crash/broker/database recovery. Existing Orders, Inventory, Payments, inbox/outbox, messaging and Phase 12 checkout regressions are included in full verification.

## 17. Implementation boundaries and remaining limitations

Implemented and integration-tested: the financial/domain/API/transport/local recovery behavior listed above, against real isolated PostgreSQL and RabbitMQ plus the existing durable mock provider.

Implemented but not tested as a production deployment: separate service-process environment/bootstrap wiring, real service-role broker provisioning against the development vhost, coordinated deployment/rolling upgrade, production metrics collection and production secrets management. Broker policy patterns were checked statically; broker integration uses the isolated test role.

Deferred: real payment-processor integration; automatic remaining-balance cancellation or settlement recognition after prior admin refunds; automatic resubmission/terminal override of definitively failed cancellation; shipment/return eligibility; arbitrary operator financial status overrides; asymmetric key isolation and Grafana. Operators can inspect and perform verified refund lookups, but unresolved outcomes still require evidence and review. No production-readiness claim is made.

Both checkout and refunds remain opt-in, with REFUNDS_ENABLED=false in the example. No development activation, migrations, resets, commits or pushes occurred. Work stops after Phase 13.
