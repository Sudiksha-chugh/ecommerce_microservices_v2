# Durable refunds, cancellation and distributed compensation

Phase 13 extends the existing opt-in checkout. It introduces no distributed transaction, second payment engine or second provider. Refunds are distinct financial operations; SQL rollback cannot reverse a provider refund.

## Activation and migration boundaries

`CHECKOUT_SAGA_ENABLED` retains its existing default. `REFUNDS_ENABLED` defaults to false and is a separate opt-in. No environment file is automatically changed to enable either workflow. Set REFUNDS_ENABLED=true explicitly for the participating Orders, Inventory and Payments processes after reviewing and authorizing migrations and broker permissions. Orders cancellation requires the existing checkout Saga to be active. Payments can expose admin refunds with refund activation even when new checkout initiation is disabled.

Version-controlled service migrations:

- Orders: `004-cancellation.sql` extends the existing Saga, cancellation idempotency receipts and refund projections.
- Payments: `004-refunds.sql` adds refunds, attempts, transition history, unique provider operations and recovery indexes.
- Inventory: `004-compensation.sql` adds RESTORED, a fulfillment barrier and per-order compensation receipts.
- Mock provider: `src/mock-provider/migrations/002-refunds.sql` adds independently persisted refund operations. The existing mock migration CLI applies it after its original charge schema.

Existing 001–003 applied migrations are unchanged. Tests apply migrations only in unique schemas of dedicated test databases. Do not apply these migrations to development databases without explicit authorization. The service code expects migration 004 when starting the updated implementation. Apply the provider migration before running refund operations. No development migration/provision/reset was performed by this implementation.

Continue using the existing service-specific broker URLs, three signing keys and outbox publishers. The provisioning source adds refund and compensation routing permissions; run `rabbitmq:provision` only as an explicitly chosen activation step. Compose remains the existing infrastructure-only stack. The existing `dev:checkout:*` scripts load `.env.checkout`, where an operator can explicitly enable REFUNDS_ENABLED. No real provider or credentials are used.

## Financial invariants and partial refunds

A captured payment can have one full refund or several partial refunds. Each amount is a positive safe integer in paise and currency must match INR. Payments serializes creation using SELECT FOR UPDATE on the captured payment. Available capacity is captured amount minus every refund except definitive FAILED. This includes REQUESTED, PROCESSING, SUCCEEDED, REQUIRES_RECONCILIATION and MANUAL_REVIEW_REQUIRED.

A workflow refund rejected for insufficient capacity is also stored durably as FAILED, with no provider attempt. Delayed transport retries return that rejection even if capacity later becomes available. Invalid/missing captured-payment linkage is classified for broker/operator review rather than inventing a financial result.

Capacity uses PostgreSQL BIGINT and JavaScript BigInt calculations, not floating-point money arithmetic. Concurrent requests cannot jointly exceed capture. Provider-side payment locking independently checks its persisted refund total. Unknown provider operations consume capacity there as well.

Idempotency is scoped to authenticated principal and the refund operation table. Identical retries return the original row; changed payment/amount/currency/reason returns 409. A provider operation UUID is persisted once and reused for every lookup. Refund attempts record one original provider operation; reconciliation is lookup work, not another refund attempt. A successful refund cannot return to processing or failure, and a reclaimed lease fences stale results.

Partial refunds are supported through explicitly authorized admin operations. They change financial state without automatically cancelling an order or changing inventory. Automatic cancellation currently requires capacity for the full immutable order amount. If prior partial refunds consume that capacity, it stops with CANCELLATION_FAILED/CAPACITY_CONFLICT and leaves financial/stock state intact. Combining previous partials with an automated remaining-balance cancellation, or recognizing an earlier full admin refund as cancellation settlement, is deferred to an explicit operator-resolution policy. It never refunds the full amount again on top of prior refunds.

## Refund state machine

- REQUESTED → PROCESSING
- PROCESSING → SUCCEEDED, FAILED or REQUIRES_RECONCILIATION
- REQUIRES_RECONCILIATION → SUCCEEDED, FAILED, itself or MANUAL_REVIEW_REQUIRED
- MANUAL_REVIEW_REQUIRED → verified SUCCEEDED/FAILED or itself, via operator lookup
- SUCCEEDED and FAILED are terminal

Claims commit before provider calls. The worker then calls `refundPayment()` once for a REQUESTED operation; expired PROCESSING work and ambiguous work call `getRefundStatus()` with the original ID. Provider results, attempt updates, transitions and signed outbox outcomes commit atomically. A crash after provider success is recovered by lookup, not a new refund operation.

Unknown results retry with bounded exponential backoff (base 30 seconds, capped at 15 minutes). Eight unknown observations escalate to MANUAL_REVIEW_REQUIRED and stop automatic refund lookups. Capacity remains reserved. An admin may request another lookup; no endpoint can simply declare an unknown operation failed or successful. Database failure leaves the durable claim recoverable by lease expiry. Multiple workers use SKIP LOCKED and fenced completion.

## Mock provider

The existing provider app gains POST /refunds and GET /refunds/:operationId. It locks the original durable charge, validates eligibility/currency/capacity and records an idempotent result in its own database transaction. Its transaction is independent of Payments.

Existing deterministic scenarios are reused for refunds:

- success: persists success and returns it;
- decline: persists definitive failure;
- temporary-failure and ambiguous: persist UNKNOWN;
- timeout: persists success, delays the response;
- lost-response: persists success, destroys the response connection.

Lookup reads the original durable record. Restarting the app preserves provider state. Tests can update an isolated provider record to simulate a later definitive settlement; production request bodies cannot choose scenarios or mutate outcomes. Random UUIDs identify operations but do not decide scenario outcomes or test expectations.

## Cancellation in the checkout Saga

Cancellation extends the Orders-owned Saga; there is no separate contradictory orchestrator. Requests and checkout event handlers lock the same Saga row. Cancellation idempotency keys are scoped to principal and operation. Concurrent different keys for the same order converge on its one durable cancellation intent and stable refund/compensation IDs.

- Eligible checkout → CANCELLATION_REQUESTED
- Before an inventory result: CANCELLATION_PENDING waits for the original reservation outcome, prevents the reservation result from issuing a payment command, then releases any reservation.
- After a payment command may have been emitted: CANCELLATION_PENDING waits for the original payment's authoritative outcome. It does not assume that unpublished/delayed work was never accepted, nor release stock during ambiguity.
- Payment success or a completed paid order: REFUND_PENDING.
- Unknown refund: REFUND_RECONCILIATION_REQUIRED; operator escalation can reach MANUAL_REVIEW_REQUIRED.
- Definitive refund failure: CANCELLATION_FAILED; the prior order/stock state remains accurate.
- Verified refund success or definitive non-payment: INVENTORY_RELEASE_PENDING.
- Committed inventory compensation response: CANCELLED for customer/admin cancellation, or COMPENSATED for automatic paid-but-unfulfilled recovery.

Orders is not marked CANCELLED when a request is accepted or merely when a refund succeeds. It waits for necessary inventory compensation. A completed paid order keeps CONFIRMED while refund is pending or failed; a paid-but-unfulfilled order remains PENDING until verified compensation can mark it FAILED. Delayed payment/confirmation events cannot overwrite cancellation intent, issue another charge or complete cancellation prematurely.

Cancellation before a reservation response may briefly reserve then release stock to resolve a possibly delivered command safely. Cancellation after reservation has already emitted a payment command resolves that operation even if it eventually requires a charge and matching refund. No unsafe “payment was never started” shortcut is used.

## Paid-but-unfulfilled evidence

Temporary confirmation delay only triggers existing retry/recovery. It never causes a refund. The legacy confirmation_failed event is still treated as unknown fulfillment/manual review.

Inventory emits `checkout.inventory.fulfillment_impossible.v1` only after locking the linked request, observing an entire reservation group in definitive RELEASED, EXPIRED or RESTORED state, and persisting fulfillment_blocked=true. That barrier prevents a delayed confirmation from proceeding. Orders can then initiate the stable full refund automatically. A successful compensation marks the Saga COMPENSATED and the order FAILED. Unknown or declined refunds remain visible for reconciliation/review.

An explicit authenticated cancellation also authorizes refund and compensation of a known paid order, even when its confirmation response was delayed. Inventory serializes compensation with confirmation and resolves either active or already-consumed stock safely. Order-finalization transaction failures are recovered by event redelivery; they are not evidence for an automatic refund.

## Inventory lifecycle and compensation

A signed compensation command must match Saga, customer, order, reservation/payment operation IDs, reservation ID and correlation. Compensation has its own stable operation ID. Inbox receipt, stock mutations, compensation receipt, fulfillment barrier and response outbox share one Inventory transaction.

- RESERVED: reuse the existing all-or-nothing release engine.
- CONFIRMED: a verified-refund operation is required; restore consumed quantities once and mark reservations RESTORED.
- RELEASED/EXPIRED/RESTORED: classify as already resolved with no stock decrement/restoration.

One compensation receipt per order prevents a new transport ID or concurrent worker from restoring twice. Conflicting compensation/refund IDs are rejected. The durable fulfillment barrier blocks delayed confirmations after compensation. Stock constraints and locking prevent negative stock; integer overflow rolls back and leaves compensation pending for operators, instead of claiming cancellation completed.

## Contracts and transactions

New strict versioned contracts preserve all Phase 10–12 payloads:

- payment.refund.requested.v1
- payment.refund_succeeded.v1
- payment.refund_failed.v1
- payment.refund_reconciliation_required.v1
- inventory.compensate.requested.v1
- checkout.inventory.compensated.v1
- checkout.inventory.fulfillment_impossible.v1

Refund payloads include refundId, paymentId, orderId, userId, refundOperationId, amountPaise, currency, reason and nullable sagaId. Workflow commands also include existing reservation/payment linkage. Standalone admin refunds have sagaId=null; Orders projects their outcomes for customers but does not infer inventory cancellation from them.

The existing signed envelope includes producer, correlation and causation. Signed commands are validated before the transactional inbox. Payments validates a workflow command against its own previously accepted checkout intent, captured payment and original amount/currency. Orders validates expected refund identity, operation, customer/payment/order linkage, amount, reason, correlation and persisted workflow state. Duplicate and stale terminal outcomes cannot repeat stock effects or overwrite success. ACK occurs after local commit; broker failures use existing retry/DLQ and publisher recovery.

## API and security

Customers may cancel their eligible Saga orders and view their own cancellation/refund status. Admins may cancel eligible orders, initiate explicitly authorized standalone full/partial refunds and inspect/reconcile unresolved refunds. Existing Inventory/Payments admin-only operations remain protected.

Orders through Gateway:

- POST /orders/:orderId/cancel: empty JSON body, required Idempotency-Key; 202 asynchronous status. Customer amounts or IDs in the body are rejected.
- GET /orders/:orderId/cancellation: Saga state, reason and actual order status.
- GET /orders/:orderId/refunds: eventually consistent projection of received refund outcomes; REQUESTED refund details are available through the owner-scoped Payments API once the command is accepted.

Payments through Gateway:

- POST /payments/:paymentId/refunds: admin only, Idempotency-Key, amountPaise/currency and optional ADMIN_REQUEST reason; 202.
- GET /payments/:paymentId/refunds: owner/admin only.
- GET /payments/refunds/:refundId: owner/admin only.
- POST /payments/refunds/:refundId/reconcile: admin only, empty body; lookup of previously processed work. REQUESTED returns 409 rather than masquerading as reconciliation.

Other owners receive 404; missing authentication returns 401 and unauthorized financial mutation returns 403. Strict schemas reject extra fields. Responses exclude provider operation/credential metadata. Existing broker role permissions and HMAC producer verification remain in force. Symmetric verification secrets assume trusted service processes; stronger compromised-service isolation requires asymmetric signing and managed secrets, outside this phase.

## Recovery, observability and operator review

Existing Orders recovery persists transport retries with the same business IDs, fenced claims and bounded backoff. It also recovers cancellation/refund/compensation commands. Payments’ refund worker independently claims REQUESTED and expired PROCESSING/ambiguous refunds. No provider network operation holds an application database transaction open.

Structured logs include refund/payment/order/Saga/correlation/event/operation identities, transition outcomes, attempt number and duration. Logs written before transaction commit explicitly say pending_commit. Existing inbox/outbox logs retain committed delivery duration and retry/DLQ observations. Refund state counts and oldest ages are logged by the Payments worker; Orders’ existing state metrics expose cancellation/compensation backlogs, stalled work and paid-but-unfulfilled/manual cases. No Grafana service is added.

Operator procedure:

1. Inspect owner/admin status, refund_attempts/refund_transitions, checkout_saga_transitions and outbox NEEDS_ATTENTION.
2. For manual unknown refunds, use the admin reconcile endpoint for another provider lookup. Never free capacity based on age.
3. Restore reviewed outbox publication attempts using the shared fenced OutboxRepository; retain event and operation IDs.
4. For failed full cancellation after earlier partials, inspect actual financial totals and leave the order/stock accurate; there is no automatic remaining-balance financial resolution.
5. For exhausted inventory compensation or overflow, investigate the durable barrier/receipt and stock state. Never restore manually merely because an ACK or response is missing.

## Local verification and test-only failure hooks

```sh
npm run typecheck
npm run test:refunds
npm run test:cancellation
npm test -- --silent
```

All integration suites use *_test_db roles, unique schemas and namespaced queues in commerce_test. Provider state is isolated in mock_provider_test_db. Hooks are dependency-injected only by test code; there is no HTTP/environment activation of production crash hooks.

Real subprocess fixtures use SIGKILL before/after refund intent commit, after provider success, before/after outcome commit, after command/outcome inbox commit, during compensation and after Orders cancellation/recovery claims. Assertions inspect actual refunds, provider rows, attempts, outboxes, transitions, stock and Saga state after restart. Broker tests exercise publication outage, duplicate outcomes and the consumer commit/ACK window. PostgreSQL tests exercise real trigger rollback, client disconnection/reconnection, and termination of the actual outcome transaction during reconciliation; they do not stop the shared development PostgreSQL server. Existing regression tests continue to cover broker connection recovery and retry/DLQ behavior.

## Remaining boundaries

This is validated against the local durable mock provider, not a real payment processor or production deployment. Automatic remaining-balance cancellation after prior admin refunds, arbitrary operator terminal-state overrides, shipment/return eligibility and production secrets management are deferred. Unknown refunds and fulfillment outcomes retain uncertainty; operational review remains necessary. Development activation/migration requires explicit authorization. Work stops after Phase 13.
