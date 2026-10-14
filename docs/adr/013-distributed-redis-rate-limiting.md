# ADR 013: Distributed Redis Rate Limiting

Status: Accepted for Phase 15, opt-in.

## Context

The existing Gateway forwards to independently authenticated services. In-memory limits would multiply permitted traffic when Gateways scale or restart. Login/registration, checkout/cancellation and financial administration need stricter budgets than public reads, while recovery workers must remain independent.

## Decision

Use the existing standalone Redis deployment through a new reusable `@ecommerce/rate-limiting` workspace. Keep Cart keys, clients and lifecycle separate. Redis supplies shared principal state and server time. One bounded Lua token-bucket execution reads/refills/evaluates every applicable bucket and spends a token only if all allow it. Separate GET/calculate/SET or sequential policy spending would permit double spending or unfair partial consumption across instances. Integer token×window balances support configurable burst capacity and rational refill without granting rounding bonuses. Idle state expires within one hour.

Reuse the shared RS256 verifier, public key, issuer/audience/expiry/claim validation before selecting a user bucket. Invalid tokens select IP state and cannot spoof subjects; service authorization still runs downstream. Login and registration remain IP-only. Trust no proxy by default; enable only validated explicit proxy addresses/CIDRs. An attacker-supplied forwarded header cannot be an identity source without that trust boundary.

Public reads default to fail open with warnings for availability. Authentication and mutation/financial/protected operations fail closed with 503 when enforcement cannot be determined. Valid denials alone produce 429. Connect/startup/command/pending work are bounded, no offline queue exists, stalled connections are replaced, and ambiguous commands are never replayed. Generated request IDs and low-cardinality local metrics provide evidence without customer identity leakage.

Keep payment/refund/body/idempotency headers unchanged. A retry after 429/503 must reuse its business idempotency key; shared rate state cannot substitute for durable Saga/payment/refund state. Recovery consumers and direct-service signed lookups remain outside external Gateway routing. There is no header-based exemption.

## Consequences and alternatives

Redis is a shared dependency for fail-closed endpoints; public fail-open trades enforcement for availability. A failed reply can accompany a spent token, conservatively, without command replay. Losing Redis state may create a fresh burst; durable business idempotency remains necessary. Capacity tuning needs measured traffic and load tests; initial values are examples.

Redis Cluster is deferred because composed keys must share a hash slot for one atomic EVAL. Independent per-policy operations would break all-or-none spending, and a universal hash tag would create a single-slot bottleneck. This phase uses a standalone primary only. No API platform, process-local fallback budget, account lockout or public metrics endpoint is added. Prometheus/Grafana deployment belongs to Phase 17.

See [architecture, configuration and test boundaries](../distributed-rate-limiting.md), [Redis scripting guarantees](https://redis.io/docs/latest/develop/programmability/eval-intro/), and [Express proxy trust](https://expressjs.com/en/guide/behind-proxies/).
