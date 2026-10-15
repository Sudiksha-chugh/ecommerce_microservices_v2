# Phase 15 — Distributed Redis rate limiting and API protection

## Baseline and scope

Read Phase 14, Notification architecture and Phase 14.1 stabilization documentation. Inspected Gateway routes/body forwarding/error handling, shared JWT verification, service authorization, Cart Redis client/lifecycle, environment validation, Compose and test infrastructure. No existing rate limiter, request-ID middleware or trusted-proxy setting existed in the Gateway. It had no Gateway Docker service. No refresh or search API exists, so no invented route/policy was added.

Before changes, **Node 24.21.0 typecheck passed and all 711 tests passed**, zero failures/skips, 66.87 seconds, 25 suites. No pre-existing failure reproduced. A fresh file-checksum inventory was saved before implementation to distinguish these edits from existing Phase 9–14.1 staged/unstaged work.

## Reuse and files

Reused npm workspaces, strict TypeScript, Express 5, Zod 4, shared RS256 verifier/identity, @redis/client 6.3.0, Redis 8 image, Vitest/Supertest, existing raw Gateway proxy and established isolated service test databases/RabbitMQ test vhost. Cart's independent Redis connection and namespace remain unchanged.

Created `packages/rate-limiting/package.json`, `tsconfig.json`; source `config.ts`, `errors.ts`, `identity.ts`, `index.ts`, `limiter.ts`, `metrics.ts`, `middleware.ts`, `policies.ts`, `redis-store.ts`, `scripts/token-bucket.lua`; test `fixture.ts`, `unit.test.ts`, `integration.test.ts`; `compose.rate-limit-test.yaml`; `docs/distributed-rate-limiting.md`; ADR `docs/adr/013-distributed-redis-rate-limiting.md`; this report and its compact results file.

Modified only these existing files in Phase 15: Gateway `package.json`, `src/app.ts`, `src/server.ts`; root `package.json`, `package-lock.json`, `.env.example`, `compose.yaml` and README. Earlier changes already in the workspace are not Phase 15 changes. No existing file was removed. Earlier 25 migration/report/Notification documentation files were checksum-verified unchanged. Config and business-service source from earlier phases were not edited.

## Redis Lua implementation and composition

Each hash persists integer balance, last refill, capacity, refill numerator and window denominator. Redis TIME supplies one script timestamp. Balance is tokens × windowMs; refill adds elapsedMs × refillTokens, caps capacity and never spends below zero. Positive bounded integer policies keep all arithmetic intermediates exactly representable; complete refill/idle expiry is at most one hour, with a one-second minimum TTL.

All required keys are read/validated/refilled in one bounded EVAL before spending any token. Admission spends one token from every bucket; denial spends none and persists only refill/clock/TTL. Policy mismatch and invalid state fail enforcement before writes. Consistent per-bucket clamped timestamps prevent a future timestamp on one bucket from advancing another. Arbitrary Redis script errors do not provide transactional rollback; operator ACL/memory/state integrity requirements are documented.

Redis keys are `ecommerce:v2:ratelimit:v1[:bounded-suffix]:POLICY:sha256(type + separator + identity)`. No Cart prefix, raw JWT, identity or user-controlled endpoint ID is used. There is no KEYS, FLUSHDB or FLUSHALL command. No Redis Cluster client/hash tags/cross-slot fallback exists; the standalone limitation and required co-location for future atomic Cluster composition are explicit.

## Identity, proxy trust and authentication

The shared verifier validates RS256 signature, issuer, audience, expiry and required UUID subject/role/iat/exp before selecting user state. Invalid JWTs use anonymous IP state without adding Gateway authorization rules; service-side authorization still decides 401/403. Bodies, arbitrary identity headers and query IDs cannot choose a bucket. Login/registration always use IP, even with valid changing tokens. IPv4, IPv6 and mapped IPv4 normalize consistently before hashing.

Proxy trust defaults off. Explicit addresses/CIDRs only, bounded to 64 entries; wildcard true, /0, host aliases and malformed prefixes are rejected. Express's socket-to-forwarded nearest-untrusted-hop behavior is preserved through a validated predicate. Direct spoofing cannot change IP identity. X-Real-IP/Forwarded do not select a bucket. Missing forwarding uses the socket; malformed selected IP data returns 400 for IP-based decisions. Tests cover IPv6 equivalence and attacker-prepended chains. A trusted proxy must sanitize forwarding and remain under deployment control.

There is no arbitrary-header or authenticated Gateway service exemption. Existing broker and direct-service recovery paths stay outside this middleware; authenticated scoped Notification lookups remain private, unforwarded routes. No new internal trust boundary is introduced.

## Route policies, headers and failures

Global anonymous burst/refill 100/minute or verified-user 300/minute compose with login 5, registration 3, checkout create/retry 10, cancellation 10, refund initiation 5, direct payment/refund reconciliation/other financial administration 10. Verified-admin mutations additionally satisfy admin 60/minute. Existing case/trailing-slash semantics are protected. Only actual proxy routes invoke the guard, before body parsing/forwarding. These are configurable token-bucket starting values, not fixed-window maximums or universally suitable production settings.

429 carries RATE_LIMIT_EXCEEDED, generic text, no-store, integer Retry-After and RateLimit-Limit/Remaining/Reset. Reset is documented delta seconds to full replenishment; Retry-After is delta seconds until all required buckets can admit a token. Denials report the longest-retry bucket; admissions report the smallest remaining/capacity ratio. No internal key/hash/principal is exposed.

Redis errors/disconnect/timeout/saturation return 503 RATE_LIMIT_UNAVAILABLE on mutations and protected reads. Public product/Inventory GET/HEAD reads default to fail open with structured warnings; an explicit option makes them fail closed. Outages do not produce 429 or invented quota headers. `/health` stays live and unthrottled; `/ready` is 503 during enabled-store outages because sensitive fail-closed routes exist, or 200 when disabled/ready.

Idempotency-Key, original body bytes and Authorization remain unchanged. Tests deny a retry before upstream forwarding, replenish the original bucket and then forward the same operation key/body. Rate limiting does not create financial operations or replace their durable idempotency. No Saga, reconciliation or broker worker is enabled or modified.

## Connection, shutdown and defects found during testing

Startup, socket/handshake attempts and whole commands are bounded; offline queueing is disabled, external pending decisions are capped and reconnect backoff is capped at two seconds. Native queue capacity reserves eight slots for the Redis startup handshake even if the request bound is one. Slow commands replace their stalled connection, discard replies and never replay possibly executed decisions. A lost reply can conservatively leave a token spent after 503/fail-open; recovery tests verify that ambiguity does not trigger another consumption.

Initial focused run: **160 passed, 2 failed of 162**. A paused real Redis reply exceeded the whole-request test deadline: inspection of the installed Redis client's `commandsToWrite()` showed it removes native timeout listeners before waiting for replies. Added the explicit whole-command timer and connection replacement, preserving the original tight deadline. The one-pending-decision fixture also exposed native queue exhaustion during handshake; reserved bounded handshake headroom while preserving the exact external request cap. The next focused run passed all 162.

Subprocess tests then exposed real shutdown defects. One run had **164 passed, 1 failed of 165**: HTTP response completed but keep-alive held shutdown until exit 1. Active responses now close after finishing during shutdown. The next run still had **164 passed, 1 failed**: a TCP connection could finish after client.destroy while its replacement was awaiting socket creation, leaving an orphaned handshake/process. The connect event now destroys late sockets belonging to closed/retired clients. Bounded handshake deadlines also recover a TCP-connected but stalled startup. Final process tests pass both clean SIGTERM and pending-command drain with zero exit status. No existing assertion or global test timeout was weakened; filtered diagnostic runs are not presented as full passes.

## Metrics, logging and configuration

Structured logs include generated requestId, fixed routePolicy, ip/user type, allowed/denied/fail-open/fail-closed decision, retry/duration, failure mode and a bounded Redis error code. Warnings distinguish unavailable enforcement. No tokens, passwords, raw identities/IPs, bodies, connection URLs or keys appear. Sink failures cannot change atomic admission. Local metrics snapshot exposes allowed/denied/Redis-error/fail-open/fail-closed counters and duration count/sum/max, keyed only by policy, through app.locals.rateLimitMetrics. Public metrics HTTP/exporter/Prometheus/Grafana remain deferred to Phase 17.

Validated environment configuration is documented in `.env.example` and the architecture document. Limiting defaults false; enabled configuration requires the matching JWT verifier settings/public key. Overrides allow separate burst/refill within finite memory/TTL/queue/time bounds. Policy mismatch requires a coordinated rollout/expiry/versioned namespace; no silent capacity reset is used. Default checkout/refund/Notification settings remain unchanged.

## Compose and isolated resources

Main Compose has only an explanatory Redis comment; no host port/volume/service behavior changed. Existing `.env.cart` keeps development Redis on 6380. The dedicated test definition uses Redis 8, a unique generated project, DB 15, random loopback host port and tmpfs, with no development mount/volume. Each case uses a distinct key prefix; cleanup destroys only that disposable project. Failure injection uses test-only TCP proxies, never development Redis stop/restart or production switches.

All temporary rate-limit projects and the disposable Notification test database were removed after verification; a read-only container inventory confirmed existing project/development services remained running. Both main Compose (with existing env files) and disposable rate-limit Compose passed `config --quiet`. No development Compose service, Redis volume, database migration or Notification profile activation/build was requested or executed in Phase 15. The actual disposable Redis/Gateway test fixtures ran successfully. The experimental generated-env container-runner Redis reuse branch is implemented but not verified in a Phase 15 container-only full run; its previously documented VM limitations remain.

## Concurrency and security evidence

Real Redis, no mock rate store, validated:

- 300 concurrent decisions over two independent connections: **15 allowed, 285 denied**, sensitive bucket exhausted and global bucket retains **25** of its original 40 tokens. No partial spending on the 285 denials.
- Two independent Gateway instances sharing the same namespace: **20 forwarded, 80 HTTP 429** for 100 concurrent public requests. Exactly 20 upstream requests were recorded.
- Refill concurrency accounts exactly for persisted elapsed Redis time minus admitted token units; no negative state or double refill. Both sensitive-denies/global-denies directions preserve other bucket balances. Idle keys expire and restore capacity.
- Real proxy disconnect after the server executes one login decision: after recovery **4 successes and 16 denials** in a 20-request burst against capacity five, demonstrating no ambiguous decision replay.
- Paused replies produce bounded 503/TIMEOUT, no 429; recovery, queue saturation, startup refusal, stalled handshake and closed-store rejection pass.
- Correct trusted/untrusted proxy chains, IPv4/mapped IPv6/canonical IPv6, invalid signature/expiry/issuer/audience/unsigned JWT, changing verified subjects, IP-only authentication routes, financial/admin composition, downstream 401/403/409 preservation, authenticated-private-route boundaries and safe telemetry all pass.

## Verification

Final focused rate-limit + Gateway run: **169 passed, 0 failed, 0 skipped**, 11.30 seconds. This comprises **44 unit/HTTP-policy tests, 45 real Redis/Gateway/security/lifecycle tests and 80 existing Gateway tests**. Typecheck and whitespace validation pass under Node **24.21.0**. Host Node 22 was not used for final verification or changed.

First frozen-code full regression: **800 passed, 0 failed, 0 skipped**, all 27 suites, 85.56 seconds. This includes all 711 baseline cases plus 89 new tests, covering Auth, Catalog, Cart, Orders, Inventory, Payments, checkout/refunds, Notifications, RabbitMQ and Outbox/Inbox. Immediate frozen-code repeat: **800 passed, 0 failed, 0 skipped**, all 27 suites, **92.23 seconds**. Independent Notifications: **66 passed, 0 failed, 0 skipped**, **13.16 seconds**. Compact aggregate results, including earlier failed development runs, are in `docs/phase-15-results.json`.

## Implemented/tested boundaries and deferrals

Implemented and integration-tested: standalone shared buckets, multi-policy all-or-none consumption, route/identity/proxy protections, HTTP headers/errors, telemetry, bounded real Redis lifecycle/outages/recovery and actual Node 24 Gateway process shutdown. Existing business regressions pass with feature defaults preserved.

Implemented but not deployment integration-tested: production reverse-proxy/network/Redis ACL configuration, application rollout sharing the existing persistent development Redis, and experimental container-runner reuse. No production rollout or development-state mutation was performed.

Deferred: Redis Cluster/HA failover support, production throughput/load benchmarks, physical Redis power-loss durability, global metric aggregation/exporters, adaptive budgets, IPv6 subnet/device aggregation, botnet/token-farming protection, absent refresh/search routes, Gateway service-identity exemptions and broader API-platform features. Fail-open public reads can be abused during outage; losing Redis state allows a fresh burst. TTL does not cap all active identities. SHA-256 over an IP is not anonymity. Operators must tune initial policies and isolate service origins so clients cannot bypass the Gateway via direct business-service access.

No prior-project file/container was changed; no previous workspace work was reset. Development business data and Redis volumes were not reset or migrated. No commit or push. Work stops after Phase 15.
