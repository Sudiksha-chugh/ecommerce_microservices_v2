# Event-Driven Notification Delivery

Status: accepted for Phase 14.

Notification delivery is asynchronous because email/provider outages must not roll back checkout, payment, refund or cancellation. Business services persist definitive outcome events in their existing outbox transactions. Notifications independently commits inbox receipt and intent, then performs delivery in a worker.

Order creation does not prove checkout completed. The minimal new order.confirmed event is committed with finalized Orders state; the existing cancellation contract is emitted only after required compensation. Existing payment/refund outcomes are reused rather than duplicated. Payment receipts and fulfillment confirmations have different purposes.

Persisted intents, logical operation identities and transactional inbox deduplication handle at-least-once event delivery and fresh transport identities from recovery. They do not prevent a provider from accepting an email before a worker crashes. Provider idempotency and status lookup are separate capabilities; ambiguous sends use the original identity and remain unresolved when safe reconciliation is unavailable. No generic exactly-once email claim is made.

Workers use database claims, leases and fencing; provider/HTTP calls occur outside Notification transactions. Definite non-acceptance can retry with bounded backoff. Permanent rejection and exhausted uncertainty remain reviewable, and manual operations are audited. Outcome classification and authoritative Orders reads suppress stale messages without treating RabbitMQ arrival order as business truth.

Database-per-service isolation matters because customer contact/financial ownership belongs to Auth/Orders, not Notifications. Scoped read-only HMAC lookups return only required context. Notifications stores minimal template/recipient snapshots, redacts logs and scrubs settled content after retention. Internal APIs require admin JWTs; optional preferences cannot suppress transactional messages.

RabbitMQ's realistic baseline is durable at-least-once transport with publisher confirmation, consumer commit-before-ACK and retry/DLQ. Event DLQs and delivery failures are separate. The dedicated notification role cannot publish business events or configure the shared exchange. The durable mock provider demonstrates one stable accepted operation through crashes, while real providers, production rollout and additional channels require their own contract/deployment evidence.
