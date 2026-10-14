# Commerce event contracts v1

Every envelope requires UUID eventId/correlationId, UUID-or-null causationId, ISO occurredAt, producer, eventType, integer eventVersion (currently 1), and strict payload. Types/schemas are exported by `@ecommerce/messaging`; unknown properties are rejected. Producers are orders-service, inventory-service, and payments-service for their respective event families. IDs normalize to lowercase. Retry/redelivery never creates a new logical event ID.

All fields below are required. UUID means a canonicalized UUID, time means an offset-aware ISO 8601 timestamp, items means 1–100 unique product UUID/positive INTEGER quantity pairs. Money is a safe integer JSON number in paise, currency INR. No address, email, password, provider identifier, or provider secret belongs in these events.

- `order.created.v1`: orderId UUID, userId UUID, totalAmountPaise non-negative money, currency, items, createdAt time.
- `order.cancelled.v1`: orderId UUID, reason CUSTOMER_REQUEST / INVENTORY_UNAVAILABLE / PAYMENT_FAILED / WORKFLOW_TIMEOUT, cancelledAt time.
- `inventory.reserved.v1`: orderId UUID, items, expiresAt time.
- `inventory.reservation_failed.v1`: orderId UUID, reason INSUFFICIENT_STOCK / PRODUCT_NOT_FOUND / INTERNAL_FAILURE, failedAt time.
- `inventory.released.v1`: orderId UUID, items, releasedAt time.
- `payment.succeeded.v1`: paymentId UUID, orderId UUID, amountPaise positive money, currency, succeededAt time.
- `payment.failed.v1`: paymentId UUID, orderId UUID, reason DECLINED / TEMPORARY_FAILURE / INTERNAL_FAILURE, failedAt time.
- `payment.reconciliation_required.v1`: paymentId UUID, orderId UUID, reason TIMEOUT / PROVIDER_UNAVAILABLE / UNKNOWN_RESULT, requestedAt time.

Envelope eventType omits `.v1`; routing key appends `.v` plus eventVersion. Schema v1 has no cross-database references. Add an explicit version/schema when making an incompatible change. `order.cancelled.v1` is defined for future consumers and currently has no binding, so mandatory publication is unroutable until a queue is deliberately added.

Phase 12 adds signed checkout commands and `checkout.inventory.*.v1` / `checkout.payment.*.v1` responses without changing legacy payloads. See [checkout contracts and stable operation IDs](checkout-saga.md#versioned-contracts).

Phase 13 adds `payment.refund.requested.v1`, refund outcome events, `inventory.compensate.requested.v1`, and checkout compensation/impossible-fulfillment responses. Existing payloads remain unchanged. See [refund contracts and transactions](refund-compensation.md#contracts-and-transactions).

Phase 14 adds `order.confirmed.v1` with authenticated owner, amount/currency, confirmation timestamp and persisted orderVersion, emitted atomically with finalized Orders state. The existing `order.cancelled.v1` is now emitted at completed cancellation. Other payment/refund contracts remain unchanged. The notification queue binds only the definitive outcome allowlist documented in [Notification mappings](notification-service.md#bindings-and-message-policy).
