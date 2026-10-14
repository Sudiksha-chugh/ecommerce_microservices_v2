# Durable Orchestrated Checkout Saga

Status: accepted for Phase 12. Refunds and post-payment cancellation are deferred to Phase 13.

Orders owns orchestration because it owns the authenticated customer order and its immutable, authoritatively priced snapshot. Inventory owns stock and Payments owns provider outcomes. Each service commits only to its own PostgreSQL database; no distributed ACID transaction spans services, Redis, RabbitMQ or a payment provider.

Local business mutations, inbox receipts and outbox envelopes commit together. Delivery is at least once: publisher confirms cannot close the crash window between broker confirmation and database publication marking, and consumers can die after commit but before ACK. Duplicate delivery is expected. Stable reservation and payment operation IDs identify business work independently of transport event IDs. Inbox deduplication handles exact redelivery; domain uniqueness and matching linkage handle commands retried with new event IDs.

A payment timeout can happen after the provider commits a charge. It proves neither failure nor success. Payments retains its payment ID, original provider request ID and operation key and performs lookups after an expired processing lease. It never sends a second charge for that payment. Provider network calls run outside database transactions, and fenced completion updates reject responses from reclaimed workers.

Saga inventory is held durably from reservation commit until linked confirmation or definitive failure compensation. Automatic TTL expiration is disabled for these holds, including before payment command delivery. This favors recoverability over stock availability. Unknown payments retain stock indefinitely and require operational attention if provider reconciliation cannot resolve them. Legacy HTTP reservations still expire normally. Public admin finish operations cannot release or confirm a Saga hold.

Compensation is a new business action, not database rollback: release commits in Inventory, then its event commits an order failure in Orders. A declined payment does not mean compensation has completed. A paid reservation that cannot be confirmed leaves the order PENDING and enters MANUAL_REVIEW_REQUIRED. Phase 12 has no refund policy and must never release its stock based on an assumed refund.

Recovery workers are necessary because a committed step can outlive its process or broker connection. PostgreSQL SKIP LOCKED claims, lease tokens, row locks and bounded retry backoff support concurrent Orders workers. Every retry preserves operation IDs. Exhaustion leaves the current recoverable state with an explicit error; it does not invent payment failure. Payments continues provider reconciliation independently. Operators can inspect audit history and outboxes and requeue reviewed publication failures.

Broker topic permissions restrict which role can publish commands or outcomes. Strict schemas and HMAC signatures additionally authenticate producer envelopes, including correlation, causation and operation linkage. This is a trusted-service boundary, not protection against a fully compromised service with verification secrets. The local symmetric-key deployment assumes all three service processes are trusted; use asymmetric signatures or a dedicated signing authority before introducing mutually untrusted producers.
