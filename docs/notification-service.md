# Event-driven Notification Service

Phase 14 adds an EMAIL-only backend service in `apps/notification-service`. There is no frontend, marketing campaign, SMS, push or WebSocket feature. Checkout and refunds retain their existing opt-in settings. Notification consumer and delivery-worker activation are independently opt-in.

## Architecture and definitive business signals

Business services commit their authoritative state and outbox together. RabbitMQ routes relevant events to the durable `notifications.business-events.v1` queue. The consumer validates producer signatures and strict schemas, maps the event, and commits the intent, outcome classification and inbox receipt in one local PostgreSQL transaction. It ACKs only after commit. It never calls Auth, Orders or the email provider inside that transaction.

A separate worker claims durable intents, resolves ownership/contact through authenticated HTTP, freezes the recipient/template snapshot, calls the provider outside the Notification transaction, and records a fenced result. Delivery failures cannot roll back checkout/refund transactions. A durable queue retains messages while the consumer is offline; the business outbox retains publication if RabbitMQ is unavailable.

The repository lacked an authoritative order-confirmed event. Phase 14 adds **order.confirmed.v1** transactionally with the Orders CONFIRMED transition, including orderId, userId, totalAmountPaise, currency, confirmedAt and persisted Saga orderVersion. The existing **order.cancelled.v1** contract is reused and emitted only when cancellation compensation finishes and the order becomes CANCELLED. Creation never triggers confirmation email. Existing contracts remain unchanged.

Initialize the notification queue/bindings before routing new finalized-order signals in a deployment. If no binding exists, the existing mandatory publisher retains an UNROUTABLE/NEEDS_ATTENTION outbox entry for operator replay rather than silently losing that signal. This does not change committed checkout/refund state.

## Bindings and message policy

The dedicated queue binds only:

- order.confirmed.v1 → ORDER_CONFIRMED
- order.cancelled.v1 → ORDER_CANCELLED
- checkout.payment.succeeded.v1 → PAYMENT_SUCCEEDED
- checkout.payment.failed.v1 → PAYMENT_FAILED
- payment.refund_succeeded.v1 → REFUND_SUCCEEDED
- payment.refund_failed.v1 → REFUND_FAILED
- payment.refund_reconciliation_required.v1 → REFUND_PENDING

Legacy payment.* events are not also subscribed: equivalent checkout payment outcomes already contain durable user/operation linkage. Inventory, checkout commands and order.created are not notification inputs. Refund unknown/manual-review events use a neutral review update, never a failed-refund message. The pending update is logically deduplicated across later manual-review observations.

A payment receipt records the financial operation and amount. Order confirmation records finalized payment/inventory fulfillment. Their text and purposes differ; the receipt explicitly does not claim fulfillment. Cancellation confirmation waits for required compensation, and refund confirmation records the separate financial outcome.

## Notification identity and stale events

Inbox deduplication handles exact eventId redelivery. Logical identity additionally hashes business aggregate/operation, notification type, EMAIL and template version. This prevents new transport event IDs from outbox/recovery replay creating duplicate intents. The first source event ID is retained for history. Order ownership is immutable and resolved from the authoritative order context where the old cancellation event has no user field.

The outcome ledger serializes each business aggregate using PostgreSQL locking. Definitive financial outcomes cannot be overwritten by stale unknown/failure messages. Cancellation takes precedence over earlier confirmation for the same order. Pending content is marked superseded; work not yet started is SUPPRESSED. In-flight/ambiguous work retains its actual delivery outcome instead of pretending it was never sent.

The worker rechecks current Orders state immediately before preparing/sending an order confirmation or cancellation. A delayed confirmation after cancellation is suppressed even if the cancellation event has not reached Notifications yet. Already accepted historical messages remain history: a subsequent cancellation does not erase an earlier true confirmation. A state change can still race the final provider dispatch; asynchronous messaging cannot revoke an email already accepted. Neutral pending updates do not assert a contradictory terminal financial outcome.

## Data ownership and schema

Production definitions use dedicated `notifications_db` and `notifications_user`. The mock provider has its own `mock_email_provider_db` and role, with a separate connection/transaction boundary. Notifications has no Auth/Orders/Payments database access and no cross-service foreign keys.

The checksum-tracked `001-notifications.sql` migration creates notifications, attempts, ordered transition history, outcome classification, minimal optional preferences, retry audit and the existing inbox schema. Indexes cover due work, recipient history, source events and aggregate identity. Positive template versions, channel/status constraints, stable unique provider operation IDs, unique intent idempotency keys and lease/sent-at consistency are enforced.

Only required template fields and the frozen recipient are stored. Mock provider records store a request fingerprint and acceptance metadata rather than email addresses or content. The worker scrubs settled recipient addresses/template/rendered content after configurable retention (default 30 days), preserving operation IDs, history and deduplication. Unresolved delivery is not silently purged or retried with a new operation; operators must resolve its uncertainty first.

Preferences contain an optional-email extension point. Every current notification is TRANSACTIONAL, so an optional/marketing preference cannot suppress order, payment, refund or cancellation messages. There is no preference mutation or marketing API in this phase.

## State machine and attempts

- PENDING → PROCESSING
- PROCESSING → SENT, RETRY_SCHEDULED, FAILED_PERMANENTLY, DELIVERY_UNKNOWN, MANUAL_REVIEW_REQUIRED or SUPPRESSED
- RETRY_SCHEDULED → PROCESSING (or SUPPRESSED by a later outcome)
- DELIVERY_UNKNOWN → PROCESSING for reconciliation, then a verified result or manual review
- MANUAL_REVIEW_REQUIRED → explicit operator reconciliation
- FAILED_PERMANENTLY → an explicitly audited retry only when the failure was exhausted definitive-transient work
- SENT and SUPPRESSED are terminal for ordinary delivery

SENT means **accepted by the provider**, not proof that a recipient opened an email or that a real SMTP mailbox delivered it. Attempt records distinguish SEND from LOOKUP. Lease recovery never assumes an external send failed. Row locks, SKIP LOCKED and claim tokens support multiple workers; a reclaimed token fences stale result persistence.

## Provider abstraction and mock behavior

EmailProvider explicitly declares idempotentSend and statusLookup capabilities and exposes sendEmail/getDeliveryStatus. Channel, content rendering and delivery result handling are separate from event intake. Additional channel adapters can be introduced later with new schemas/templates; only EMAIL is accepted today.

DeterministicMockEmailProvider persists independently:

- success: one stable accepted operation/message ID;
- temporary: definite non-acceptance, safe to retry the same operation;
- permanent: definitive rejection, no ordinary retry;
- timeout/lost-response: durable acceptance followed by UNKNOWN to the worker;
- unavailable: send definitively not accepted, lookup remains unknown;
- unknown: a durable unresolved operation.

Timeout/lost-response model an unavailable provider result after acceptance; this local mock does not perform actual SMTP or an external paid-provider HTTP request. Lookup survives process restart because provider state is in a separate database. Request fingerprints prevent changing recipient/content under an existing operation ID. Tests assert one accepted provider operation, not real-world mailbox exactly-once delivery.

Intent uniqueness is **not** delivery idempotency. A provider can accept a send before the worker dies. With lookup, recovery checks the same operation. With idempotent send but no lookup, recovery can repeat the same frozen request safely under that provider contract. With neither capability, ambiguous work enters manual review without a blind resend. A definitive “not accepted” lookup may schedule a safe retry. No exactly-once guarantee is claimed for arbitrary real providers.

## Retry and DLQ policy

Definitive transient failures persist backoff around 30 seconds, 2 minutes, 10 minutes and 30 minutes, with bounded jitter and a 30-minute cap. Maximum failures/reconciliation observations are configurable (default five). SEND and LOOKUP preserve the same provider operation identity and frozen recipient/content. A definitive permanent rejection stops; transient exhaustion is reviewable and can be explicitly retried with an audit entry. Unknown exhaustion remains MANUAL_REVIEW_REQUIRED.

Event failure is separate from delivery failure. Invalid JSON/schema/version, unsupported routing/mapping and forged producers use the existing broker retry/DLQ disposition. There may be no notification row for such a message. Recipient errors, provider rejection/exhaustion and ambiguity live in notification state/history and operational APIs; they are not masqueraded as event DLQ failures. No permanent failure is automatically replayed.

## Recipient resolution and authorization

Auth stores email and exposes a new opt-in GET /internal/users/:id/contact, returning only userId/email. Orders exposes GET /internal/orders/:orderId/notification-context, returning owner/status/amount/version. The Orders lookup works independently of checkout activation, including for legacy order snapshots. Neither route is added to Gateway public forwarding.

Notifications signs GET method/path/caller/timestamp with a configured 32+ character NOTIFICATION_LOOKUP_KEY. Services enforce a 30-second window and constant-time signature comparison. Customer/admin JWTs alone cannot use these read-only internal lookups. The worker validates returned IDs, claimed event user/order ownership, current state and email format; it never accepts an arbitrary address from RabbitMQ.

Existing business-event HMAC validation is reused. Notifications needs Orders/Payments verification keys for its allowlist, not the Inventory signing secret. Symmetric verification assumes trusted service processes; a compromised verifier with a shared key is outside this local trust boundary. Asymmetric signing/rotation and managed secrets remain deployment work.

The Notification PostgreSQL role is isolated. RabbitMQ uses a dedicated notification role, owned queues/retry/DLQ/handoff resources, exact topic read bindings and no business-event publication permissions. The notification-only client passively checks the pre-existing commerce exchange rather than configuring it. Exchange/queue permission distinctions follow [RabbitMQ's access-control documentation](https://www.rabbitmq.com/docs/access-control).

## Operational API

All /internal/notifications routes require a verified admin JWT; customers receive 403 and missing/invalid JWTs receive 401.

- GET /internal/notifications: strict status/type filters, limit 1–100 and bounded offset.
- GET /internal/notifications/:id: sanitized status/history summary.
- GET /internal/notifications/:id/attempts: at most 100 attempts.
- POST /internal/notifications/:id/retry: empty body, safe-state guard, stable operation ID and durable principal audit. SENT/permanent rejection/superseded/purged content is rejected with 409. Unknown/manual work requests reconciliation, not a fresh send.
- GET /internal/notifications/health and /readiness: admin liveness/readiness.
- GET /internal/notifications/metrics: structured backlog, age, delivery counts and duration data for later integration.

GET /health is the usual nonsensitive liveness endpoint. No raw recipient addresses, rendered content or provider credentials are returned by the operational summaries. Customer history endpoints are intentionally deferred; ordinary customers cannot enumerate notification records. No frontend or unrestricted bulk API is added.

Logs contain notification/event/correlation/provider-operation IDs, type, channel, attempt, status transition, duration and outcome. They omit addresses, template bodies, tokens and exception messages. Pre-commit intent logs identify pending_commit. Prometheus/Grafana deployment is deferred to Phase 17.

## Local setup and Compose

Application port **4007** is unused by existing services; 4006 belongs to the payment mock. Notifications' dedicated PostgreSQL host port defaults to **5440**, without changing any existing mapped port or volume. New Compose services notification-service and notifications-db are under the optional **notifications** profile, so existing default infrastructure commands do not start them. The new store has its own persistent volume and boot provisioning script. No service migration runs automatically at application startup.

Copy .env.notifications.example to a gitignored .env.notifications. Supply distinct database/provider credentials, matching JWT settings/public key, a dedicated broker URL, lookup key and the required producer verification keys. Configure the lookup key explicitly in Auth/Orders and restart those services only as an authorized deployment action. Enable the Notification consumer/worker explicitly when ready; never enable checkout/refunds implicitly.

Use the existing Compose env files plus .env.notifications when invoking the optional profile. Apply Notification and mock-provider migrations only after explicit authorization to modify development schemas:

```sh
npm run notifications:migrate
npm run notifications:mock:migrate
npm run dev:notifications
```

The optional Dockerfile uses the repository's Node 24 engine. Compose points Auth/Orders HTTP lookups at configurable origins (host.docker.internal by default); operators must set origins matching their actual service deployment. Bootstrap the business exchange and dedicated notification queue once before expecting finalized-order publications to route. Broker provisioning reads the optional RABBITMQ_NOTIFICATIONS_PASSWORD; it preserves the existing service roles when that value is absent.

## Isolated testing and recovery evidence

```sh
npm run notifications:test:up
npm run typecheck
npm run test:notifications
npm test -- --silent --maxWorkers=1
npm run notifications:test:down
```

The test project is **commerce-v2-phase14-test**, using port 55440 and temporary PostgreSQL storage, never development volumes. Fixtures create unique test-only databases/roles for Notifications, provider and source-service HTTP integration, revoke cross-database connection, and remove only their generated resources. RabbitMQ tests use namespaced commerce_test queues and temporary isolated least-privilege identities/vhost. Existing regressions continue to use their established test databases; pre-existing infrastructure failures are reported separately.

SIGKILL fixtures cover intent before/after commit, claim, pre-send snapshot, provider acceptance, result before/after commit and an actual broker consumer after commit before ACK. Tests terminate the actual Notification result transaction's PostgreSQL connection and recover by lookup. Other checks cover duplicate/new-transport events, concurrency/fencing, event DLQ, recipient mismatch, retention, HTML escaping, secret-free logs, guarded operator retry and stale/out-of-order suppression.

The business-outage test completes real persisted checkout, refund and cancellation while Notifications has no consumer, then resumes from the durable queue. It does not claim success merely from mocked call counts.

## Operator procedures and limits

Inspect status, attempts, source event IDs, transition history and metrics before retrying. Reconcile unknown provider operations with the original ID; do not assign a new send key because a response is missing. Resolve Auth/context availability before rescheduling known-transient work. Review event DLQs separately from failed email rows. Requeue reviewed unroutable business outboxes only after the queue binding exists, preserving the envelope.

The local mock ideal path is tested; a real SMTP/paid provider, delivery/open/bounce callbacks, customer inbox, marketing, new channels, production image rollout and production secret management are deferred. A message already accepted cannot be recalled by a later cancellation. Unknown outcomes remain explicit. Development activation/migrations are not performed automatically. Work stops after Phase 14.

## Conservative recovery details

Expired claims retire the old attempt as UNKNOWN with WORKER_LEASE_EXPIRED before reconciliation. Failure and uncertainty counters retain transition history after later success. A negative lookup cannot authorize a resend without provider idempotency: an old worker may still be dispatching. Such outcomes require manual review. A superseded ambiguous intent without lookup remains reviewable rather than resending obsolete content. The deterministic timeout scenario models accepted delivery followed by a lost response; it is not an SMTP or network-timeout implementation.

## Phase 14.1 reproducible integration runs

The verified Phase 14.1 full workflow is Node.js 24 with `npm test -- --silent` and the established test databases/vhost. As an experimental alternative, `npm run test:isolated -- --silent` creates fresh PostgreSQL, RabbitMQ and Redis stores on random localhost ports, runs the complete regression suite in a Node 24 image, and removes its own resources. Container-only full results on this local VM remain non-green; see the stabilization report. `npm run test:isolated -- apps/notification-service/test --silent` runs Notifications independently with the same isolation. Generated env files and test role guards keep the stores separate from development. Test files run serially; concurrent worker/request scenarios remain concurrent.

`npm run notifications:smoke` builds the actual Notification image and smoke-tests the optional Compose profile with disposable overrides, generated JWT keys, signed test-only contact endpoints, and no development volumes. It checks disabled defaults before explicitly activating only its temporary service. See `docs/phase-14-stabilization-report.md` for results and limitations. The smoke override requires Compose support for `!override`/`!reset`.

For read-only diagnostics against established local test stores, run `node scripts/integration-diagnostics.mjs`. Output contains resource counters and test queue names, not passwords or customer content.
