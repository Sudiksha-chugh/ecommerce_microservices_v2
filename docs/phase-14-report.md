# Phase 14 — Event-driven Notification Service

## 1. Baseline verification

Repository conventions and Phase 12/13 reports and architecture documents were inspected before changes. Typecheck passed. Baseline full tests: 642 passed, 2 failed of 644; both failures were existing Payments timing waits (provider I/O transaction test and bounded-worker shutdown). Sequential baseline: 261 passed, 3 failed, 380 skipped; local PostgreSQL hooks/connections and RabbitMQ startup timed out. Existing work was preserved.

## 2. Existing infrastructure reused

Strict TypeScript/npm workspaces, Express/Zod, pg, shared signed event envelopes, RabbitMQ Messaging lifecycle/retry/DLQ, transactional InboxProcessor, checksum migrations, JWT authorization and bounded poll-worker shutdown were reused. No new framework, frontend or paid provider.

## 3. Files created

`apps/notification-service/` contains workspace configuration, checksum migration, validated configuration, database role guards, mapping/state machine, repository, recipient resolver, templates, provider interface and independently durable mock, consumer, worker, HTTP app/server and unit/integration/crash fixtures. Additional files: `packages/security/src/internal-service.ts`, `apps/orders-service/src/notification-context.ts`, `.env.notifications.example`, `compose.notifications-test.yaml`, Notification Dockerfile and database init script, `docs/notification-service.md`, ADR 012 and this report.

## 4. Files modified

Auth app/server add scoped contact lookup. Orders app/server add scoped order context independent of checkout activation; Saga repository emits finalized order outcomes transactionally. Shared contracts add order.confirmed; security exports the internal signature helper. Messaging topology and broker provisioning add restricted notification consumption. Poll worker accepts an optional component label. Root package/lock, Compose, Docker ignore, Git ignore, environment examples, README and event-contract documentation add the workspace/setup. Earlier phase migrations, reports and existing tests were not rewritten.

## 5. Database migrations

New `001-notifications.sql` creates intents, attempts, transition history, outcome ledger, inbox, optional preference extension and retry audit. Stable logical/provider identities, indexes, state constraints and lease fencing are persisted. Mock email schema lives in its own database/role. No cross-service foreign keys. Migrations ran only against generated Phase 14 test databases on a new tmpfs PostgreSQL cluster, port 55440. Development databases were neither migrated nor reset.

## 6. RabbitMQ topology changes

Dedicated durable notifications.business-events.v1 plus existing retry/DLQ/handoff conventions. Seven exact bindings only. Notification-only setup passively checks the shared exchange. Provisioning supports dedicated credentials that cannot configure or publish the shared exchange and cannot read another service queue. This policy was tested using temporary users and a temporary vhost, then removed. Development provisioning was not invoked.

## 7. Notification event mappings

order.confirmed → ORDER_CONFIRMED; order.cancelled → ORDER_CANCELLED; checkout.payment.succeeded/failed → PAYMENT_SUCCEEDED/FAILED; payment.refund_succeeded/failed → REFUND_SUCCEEDED/FAILED; payment.refund_reconciliation_required → neutral REFUND_PENDING. Only the missing finalized order-confirmed signal was added. No order.created confirmation. Receipt and fulfillment confirmation have distinct messages. Unknown/manual review never becomes a definitive customer failure.

## 8. State machine implementation

PENDING, PROCESSING, SENT, RETRY_SCHEDULED, FAILED_PERMANENTLY, DELIVERY_UNKNOWN, MANUAL_REVIEW_REQUIRED and SUPPRESSED have guarded durable transitions. SKIP LOCKED claims commit before HTTP/provider work. Tokens and lease checks fence stale updates. Expired attempts retain an explicit unknown outcome. Cancellation/terminal outcome precedence and authoritative order lookup suppress obsolete unsent content.

## 9. Provider abstraction

Explicit idempotentSend/statusLookup capabilities, sendEmail and getDeliveryStatus. PostgreSQL-backed mock supports success, temporary/permanent rejection, modeled timeout/lost response, unavailable and persistent unknown. Mock transactions are independent of Notification transactions and survive process restarts. No real SMTP or paid provider integration. SENT means provider acceptance.

## 10. Delivery idempotency

Inbox event identity and aggregate/type/channel/template logical identity deduplicate intents. Separate stable provider operation IDs deduplicate mock acceptance. Database uniqueness alone cannot guarantee once-only external email. Ambiguity reconciles through lookup; safe same-operation resend requires idempotent provider support. A negative lookup without idempotency cannot authorize a potentially racing resend. Superseded unknown content without lookup requires review. No universal exactly-once claim.

## 11. Retry and DLQ behavior

Persisted bounded jittered backoff defaults to 30 seconds, 2 minutes, 10 minutes and 30 minutes; attempts configurable. Invalid/schema/version/forged events use RabbitMQ DLQ. Delivery failures remain operationally reviewable database records. Permanent rejection and SENT are not replayable; exhausted definitive transient failures permit audited retry. Unknowns use reconciliation or review, never blind resend.

## 12. Recipient resolution

Scoped timestamped HMAC HTTP reads bind caller, method and path. Orders supplies immutable owner/current business context; Auth supplies validated contact. Notifications cannot connect to Auth or other business databases. Address/content snapshot freezes before provider dispatch. Temporary lookup outage retries; permanent missing/invalid contact is reviewable.

## 13. Authorization

Operational list/detail/attempt/retry/health/readiness/metrics routes require admin JWT, bounded validated filters and safe output. Ordinary customers receive 403, missing JWT 401. Retry bodies cannot choose recipient/content and audit principal identity. Logs omit addresses, bodies and provider secrets. Terminal content retention scrubs personal payloads; unresolved delivery is preserved. Transactional notices cannot be suppressed by optional preferences.

## 14. Recovery test evidence

Real subprocess SIGKILL tests cover pre/post intent commit, post-claim, pre-provider, post-provider acceptance, pre/post result commit and broker commit-before-ACK. A real PostgreSQL backend termination rolls back result persistence, followed by successful reconciliation. Concurrent workers and stale tokens are tested. Durable provider records show one accepted operation after recovery. Real RabbitMQ validates redelivery, invalid/forged DLQ, temporary least-privilege roles and checkout/refund/cancellation completion while Notifications is offline. No production failure-injection environment switches were introduced.

## 15. Final test results

Final Notification suite: **66/66 passed**, including 16 unit and 50 integration tests, on isolated PostgreSQL and test RabbitMQ. Final typecheck and git diff --check passed. Compose profile configuration validated without starting development services.

Full sequential regression was executed: **696 passed, 12 failed of 708**, 20 suites passed, 5 failed, about 29 minutes. Failures: existing Messaging interrupted-publication wait, existing checkout broker E2E, existing refund reconciliation wait, six existing event-persistence broker waits, and three new Notification broker-readiness waits. A concurrent Notification run also had three readiness failures (63/66). Notification subsequently passed all 66 alone in 19.57 seconds, then passed all 66 again with the narrowed Notification-only fixture topology in 56.84 seconds. These observed timing/readiness failures are not a clean full-regression pass; shared infrastructure contention is a possible contributor, not proven causation. Existing assertions were not weakened.

## 16. Known limitations

Implemented and integration-tested: durable intents, worker/provider recovery, signed lookups, admin APIs, source lifecycle/outage isolation, role isolation and real broker routing/permissions. Implemented but not deployment integration-tested: development Compose profile, Node 24 image build/start, fresh development init/provisioning and real-provider adapter (none supplied). Host tests used Node 22.23.3 despite repository engine Node 24. Real SMTP acceptance/delivery, bounces and provider webhook authentication are untested and not implemented. Async dispatch can race a later business transition; accepted email cannot be revoked. Symmetric producer keys require trusted service secret custody. Full regression remains non-green as detailed above.

## 17. Deferred functionality and safety

Customer history/Gateway integration, preference mutation, marketing, additional channels, paid/SMTP providers, webhooks and full Prometheus/Grafana remain deferred. Notification worker/consumer, checkout and refunds remain opt-in. Development app uses unused port 4007, dedicated optional database port 5440; existing ports/volumes preserved. Only new isolated test resources were created and cleaned. Previous e-commerce project untouched. No commit, push or Phase 15 work.
