# Durable Refunds and Distributed Compensation

Status: accepted for Phase 13.

Refunds are separate financial operations with their own durable IDs, attempts, capacity reservation, state and audit history. A provider refund can commit independently of PostgreSQL; rolling back a local transaction cannot reverse that transfer. No distributed ACID transaction is introduced.

Payments owns capture and refundable balance. Creation locks the captured payment and includes all non-definitively-failed refunds in reserved capacity. Counting only successful refunds would allow concurrent requested/processing/unknown operations to over-refund. Partial admin refunds are supported; automatic cancellation stops if a full refund conflicts with earlier partials instead of guessing a remaining-balance policy.

Provider idempotency is authoritative. Worker leases and tokens fence local persistence, but they cannot undo a provider call from an expired worker. One original operation ID is reused for every lookup and never replaced during recovery. The durable mock provider independently locks capture and enforces idempotency/capacity.

An ambiguous refund is not a failure. A timeout may follow a completed provider refund. Unknown work retains capacity and reconciliation state. Eight unknown observations escalate to operator review; review is not a financial terminal outcome. Only a definitive provider lookup can resolve success/failure through the review endpoint.

Orders continues to own cancellation and compensation in its existing checkout Saga. Row locking serializes cancellation intent with checkout outcomes and recovery. Possibly delivered payment work is resolved rather than assumed absent. Refund success precedes inventory compensation, and cancellation completes only after Inventory acknowledges its committed business action. Temporarily delayed or unknown fulfillment does not automatically trigger a refund; automatic paid-but-unfulfilled recovery requires a durable impossible-fulfillment barrier from Inventory.

Inventory compensation distinguishes releasing held stock from restoring consumed stock. A per-order compensation receipt, stable operation ID, transactional inbox, stock locks and fulfillment barrier prevent repeated restoration and late confirmation races. Confirmed stock requires verified-refund authorization from the signed orchestrator command.

Compensation is a sequence of new business actions, not a distributed rollback. Inbox/outbox commit each local action durably and tolerate duplicate transport delivery. Recovery uses existing publisher confirmation, retry/DLQ and fenced worker machinery. Operator review remains necessary for persistent provider uncertainty, publication exhaustion, prior-partial refund conflicts, stock overflow or unknown fulfillment. No terminal financial outcome is inferred from age or missing messages.

Security preserves customer ownership and admin financial authorization, strict versioned envelopes, dedicated broker roles, signed producer identity and persisted linkage validation. The local symmetric-key trust boundary assumes trusted service processes. Real payment-provider integration, compromised-service isolation and a production-readiness claim require additional deployment evidence.
