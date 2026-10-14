# Distributed Redis rate limiting

Phase 15 adds opt-in protection to the existing API Gateway through `@ecommerce/rate-limiting`. Business services, RabbitMQ consumers and Saga/reconciliation workers retain their existing interfaces. No service migration, frontend, account lockout or API management platform is introduced.

## Architecture and repository audit

The Gateway previously forwarded raw request bodies and Authorization/Idempotency-Key headers without verifying JWTs. Services authenticate and authorize locally using `@ecommerce/security`; public Catalog and Inventory reads do not require authentication. Auth exposes login, registration and `/auth/me`; there are no refresh or search routes. Cart and Orders reads/writes require customer/admin identities; Catalog/Inventory mutations and direct payment/refund administration require admin authorization downstream. Checkout, cancellation, payment processing/reconciliation and refunds are sensitive. No rate limiting existed.

The existing Cart Redis client uses `@redis/client`, offline-queue rejection, reconnect backoff and sanitized errors. The limiter reuses that library and conventions through a separate Gateway-owned connection, rather than sharing a Cart service connection or its key lifecycle. Default Gateway protection remains disabled. The existing standalone Redis can serve both namespaces without changing Cart code, ports, persisted keys or volumes.

Every registered proxy route runs the guard before the existing 100 KB raw-body parser and forwarder. Unknown paths are still 404 and do not allocate buckets. `/health` remains cheap liveness; the new `/ready` reports disabled/ready/degraded. A generated UUID is returned as `X-Request-Id` and used in limiter logs; client-supplied request IDs do not select log identities. Existing disabled-mode forwarding and service authorization remain covered by regressions. Existing security behavior (disabled Express signature and downstream cache/authentication headers) remains in place.

## Integer token bucket and atomic composition

Each policy has `capacity`, `refillTokens` and `windowMs`. Capacity controls the immediate burst independently of sustained refill. Available balance is stored as **tokens × windowMs integer units**. Redis `TIME` supplies milliseconds within the Lua execution. Refill adds elapsed milliseconds × refillTokens, capped at capacity × windowMs; spending one request subtracts windowMs. Bounds keep arithmetic intermediates below JavaScript/Lua's exact integer limit. Nodes' wall clocks never determine refill.

One `EVAL` receives all required keys and policy triples. It reads and validates all existing states, computes refill for every bucket and checks whether every balance permits one token. Only if all permit admission does it subtract from any bucket. On denial it persists replenished balances without spending tokens. Existing balances, capacity, refill, window and last-refill time are stored in Redis hashes. A mismatched persisted policy or malformed state yields an enforcement error before writes rather than silently resetting capacity. A backward refill clock is clamped per bucket; operating Redis with a disciplined clock is still required.

For a deficient balance, retry milliseconds are `ceil((windowMs - balance) / refillTokens)`. Reset milliseconds describe full replenishment: `ceil((capacity × windowMs - balance) / refillTokens)`. Idle expiry is the complete-refill duration, at least one second and at most one hour. At expiry a new full bucket is equivalent to its fully replenished old state. Requests, including denials, refresh that bounded TTL; unused keys disappear. TTLs bound idle retention, not total memory against arbitrarily many active clients. Capacity planning and restricted network/Redis access remain necessary.

The script has at most eight keys and does no loops over unrelated data. Its text is constant; identities are arguments, never interpolated script source. `EVAL` avoids a NOSCRIPT recovery/replay path. Lua provides isolation from competing clients, not general transactional rollback for arbitrary runtime failures. Use a writable standalone primary with compatible ACLs for all required commands and rate-limit keys, reserve memory, and do not let other writers corrupt these hashes. See [Redis scripting guarantees](https://redis.io/docs/latest/develop/programmability/eval-intro/).

## Policies on actual endpoints

Each request also satisfies GLOBAL_ANONYMOUS (IP; burst 100, refill 100/minute) or GLOBAL_AUTHENTICATED (verified subject; burst 300, refill 300/minute).

- POST `/auth/login`: AUTH_LOGIN, burst/refill 5 per minute by IP, even with a valid access token.
- POST `/auth/register`: AUTH_REGISTER, 3 per minute by IP.
- POST `/checkout` and `/checkout/:orderId/retry`: CHECKOUT_CREATE, 10 per minute.
- POST `/orders/:orderId/cancel`: ORDER_CANCEL, 10 per minute.
- POST `/payments/:paymentId/refunds`: REFUND_CREATE, 5 per minute.
- Other registered POST `/payments/...` routes, including intent/process/reconciliation and refund reconciliation: ADMIN_FINANCIAL, 10 per minute.
- Verified-admin mutations outside login/registration additionally satisfy ADMIN_OPERATIONS, 60 per minute. This includes Catalog/Inventory writes and administrative financial actions.
- Other registered routes use the applicable global policy. GET/HEAD Catalog products and Inventory item reads are public reads; protected reads remain fail closed.

Sensitive routes use a verified user when available and an IP otherwise; downstream services still reject missing, invalid or unauthorized credentials. A valid customer token cannot grant admin authority at the Gateway. Case-insensitive/trailing-slash variants matching Express receive the same policies. IDs and query strings are not policy dimensions. AUTH_REFRESH and SEARCH are deliberately absent because those APIs do not exist.

These are starting settings, not universal production limits. Measure real burst distributions, allowed/denied rates, retry behavior, provider costs and Redis latency; load-test several concurrent Gateways before choosing capacities and refill rates. Shared-IP users, mobile clients and admin workflows need particular attention. Apply the same configuration to every instance. Live policy mismatch fails enforcement until old keys expire; planned coordinated changes or a new versioned prefix are required. A new prefix starts fresh buckets, so it must not be used as an accidental bypass during rolling deploys.

## Identity, JWT order and trusted proxies

The limiter calls the **existing shared RS256 verifier**, requiring signature, issuer, audience, expiry, subject/role/iat/exp and UUID subject. It needs only Auth's public key. Verification selects a bucket; downstream authentication/authorization is unchanged, and the original Authorization bytes are forwarded. Invalid/expired/unsigned/wrong-issuer/wrong-audience tokens use the IP bucket and cannot choose a subject. Login/registration always use IP without token-dependent buckets. Request bodies, query IDs, user headers and decoded-but-unverified payloads are never identity sources.

Node validates the selected IP; ipaddr.js normalizes IPv4/IPv6 and converts IPv4-mapped IPv6 to IPv4. IPv6 equivalent spellings share a bucket. Keys contain SHA-256 over identity type plus a separator plus normalized IP/verified subject. Type separation prevents identity collisions. Hashing avoids raw identities in keys but is not anonymity for guessable IP addresses. IPv6 subnet aggregation, device fingerprints and resistance to botnets/token farming are deferred.

`RATE_LIMIT_TRUSTED_PROXIES` accepts up to 64 explicit IP addresses/CIDRs. Empty means no trusted proxy. `/0`, blanket true, hostname aliases, malformed prefixes and zone addresses are rejected. Express walks the forwarded chain from the socket toward the nearest untrusted hop using this predicate. Direct untrusted clients' X-Forwarded-For is ignored; X-Real-IP and Forwarded do not select identities. Missing forwarding falls back to the socket IP; malformed selected forwarding for an IP-based decision returns 400 before Redis or upstream work. See [Express proxy configuration](https://expressjs.com/en/guide/behind-proxies/).

Only list proxies that operators control. The edge must sanitize incoming forwarding headers and append/replace its validated client address. Restrict direct Gateway reachability when trusting that edge, and account for every possible hop/path. Broad trusted private subnets can admit compromised clients inside those networks; prefer exact proxy addresses or narrowly managed CIDRs. A configured trusted proxy that lies about clients is outside this trust boundary. Proxy trust is applied when protection is enabled; disabled deployments retain their previous direct-client configuration.

## Failure behavior and connection lifecycle

A valid denied decision returns **429** with `RATE_LIMIT_EXCEEDED` and a generic message. Redis unavailability, disconnect, command deadline, queue saturation, invalid state or incompatible policy never becomes 429. These produce **503** with `RATE_LIMIT_UNAVAILABLE` on protected reads and every mutation/sensitive operation. Public GET/HEAD products/Inventory reads default to fail open with a structured warning; setting `RATE_LIMIT_FAIL_OPEN_PUBLIC=false` closes those too. Fail open temporarily bypasses enforcement and returns no invented quota headers. These choices trade public-read availability against abuse protection; financial/auth writes prioritize enforcement.

Gateway startup waits only the bounded connect budget, then can serve degraded. `/health` remains 200. `/ready` is 503 if an enabled Redis store is unavailable, since this deployment always contains fail-closed routes, even while public reads still work. Disabled readiness is 200. Background reconnect attempts use bounded socket and handshake attempts and exponential delays capped at two seconds. There is no offline request queue or automatic decision retry.

An explicit whole-command timer covers both write and reply time: this Redis client version's native command timeout ends when it writes the command. If the whole-command deadline expires, the store destroys/replaces the stalled connection, dropping queued replies, and reconnects. Exact external pending decisions are bounded by configuration; the native queue has at least eight slots for the startup handshake. Shutdown rejects new store commands, destroys pending connections/reconnects and drains bounded decision promises. Gateway SIGTERM stops HTTP acceptance, closes keep-alive responses after active work finishes and closes the store; the existing shutdown deadline remains a final bound.

A disconnected/timed-out command may have executed in Redis. It is **never retried automatically**; a 503 or fail-open result may therefore accompany an already-spent token. This conservative ambiguity cannot overspend a bucket through client replay. Clients should back off and reuse their existing business idempotency key. Limiting does not rewrite bodies, assign payment/refund operation identities, or replace Saga/payment/refund idempotency.

## Internal traffic

There is **no Gateway internal exemption**. Arbitrary X-Internal-Service or signature-looking headers cannot bypass a customer limit. Legitimate RabbitMQ consumers, Saga recovery and reconciliation use their existing broker/direct-service paths, outside the external Gateway middleware. Existing Notification lookups use timestamped scoped HMAC identity at Auth/Orders and are not forwarded publicly. Do not redirect recovery workers through the Gateway expecting an exemption. Adding authenticated Gateway service identities or exempting trusted network ranges is deferred; any future bypass needs an explicit authenticated trust boundary.

## HTTP headers

Both allowed and denied valid decisions include the requested compatibility fields:

- `RateLimit-Limit`: constraining bucket burst capacity as an integer.
- `RateLimit-Remaining`: available whole tokens after this decision.
- `RateLimit-Reset`: integer **delta seconds until that bucket fully replenishes**, rounded up; not an epoch timestamp or fixed-window reset.
- On 429 only, `Retry-After`: integer delta seconds until **all denied buckets** can admit one request, rounded up and at least one second.

On denial the constraining bucket has the longest retry. On admission it has the smallest remaining/capacity fraction (stable first-policy tie). Only its values are reported; policy names, keys/hashes and identities are not HTTP payloads. 429/503 are no-store. The requested RateLimit-* fields are a documented compatibility format, not a claim of compliance with every evolving RateLimit draft. Retry-After uses the [HTTP delta-seconds form](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).

## Configuration and operations

`.env.example` documents the opt-in settings. Existing Gateway npm scripts load root `.env`; public-key paths are relative to the Gateway workspace working directory, as in the other services.

- RATE_LIMIT_ENABLED=false.
- RATE_LIMIT_REDIS_URL=redis://127.0.0.1:6380/0 (use rediss/auth credentials and network ACLs outside local development).
- RATE_LIMIT_KEY_PREFIX=ecommerce:v2:ratelimit:v1; optional bounded alphanumeric test/deployment suffix.
- RATE_LIMIT_CONNECT_TIMEOUT_MS=1000, range 10–10000.
- RATE_LIMIT_COMMAND_TIMEOUT_MS=200, range 10–5000.
- RATE_LIMIT_MAX_PENDING=100, range 1–1000.
- RATE_LIMIT_FAIL_OPEN_PUBLIC=true.
- RATE_LIMIT_TRUSTED_PROXIES= (comma-separated addresses/CIDRs).
- RATE_LIMIT_POLICY_OVERRIDES={} (strict JSON with known policy names only).
- JWT_PUBLIC_KEY_FILE, JWT_ISSUER, JWT_AUDIENCE required when enabled; issuer/audience/key must match Auth and services.

For example, `RATE_LIMIT_POLICY_OVERRIDES={"AUTH_LOGIN":{"capacity":8,"refillTokens":5,"windowMs":60000}}` permits burst eight while sustaining five/minute. Policy numbers are positive bounded integers, capacity/refill at most one million, window 100–3600000 ms, and complete refill at most one hour. Invalid configuration fails before connecting or installing middleware, with no secret value in the error. Empty/default settings do not activate checkout, refunds or Notifications.

Structured decision logs include requestId, routePolicy, identityType, decision, retryAfterMs, redisDurationMs, failureMode and a bounded Redis error code. Failures are warnings; normal decisions are information logs. Log-sink errors do not alter admission. No IP, user ID, JWT, password, request body, connection URL or Redis key is emitted. Decisions currently log every protected request; high-volume deployment sampling/backpressure is future operational work.

`RateLimitMetrics.snapshot()` is available through `app.locals.rateLimitMetrics` on an enabled Gateway. It provides rate_limit_allowed_total, denied_total, redis_errors_total, fail_open_total, fail_closed_total and decision_duration_ms count/sum/max, keyed only by the fixed constraining policy name. Metrics are process-local, not distributed counters. There is no public unauthenticated metrics endpoint, exporter or Prometheus/Grafana deployment; those belong to Phase 17.

Use readiness, sanitized error codes, denial/retry rates and duration metrics to distinguish saturation/outage from ordinary throttling. Check Redis reachability/ACL/TLS, latency, memory and persisted policy compatibility before changing limits. Never use KEYS *, FLUSHDB or FLUSHALL on a shared store. Do not delete Cart keys or reset Redis volumes. Production ACLs should restrict commands and keys to this namespace; managed credentials, HA and deployment orchestration remain operator responsibilities.

## Local tests and Compose

Use Node.js 24, Docker and the existing regression test databases/vhost:

```sh
npm run typecheck
npm run test:rate-limiting
npm test -- apps/api-gateway/test
npm run notifications:test:up
npm test -- --silent
npm run notifications:test:down
```

The new Redis integration fixture starts a uniquely named `commerce-v2-rate-limit-test-...` project using `compose.rate-limit-test.yaml`. Redis 8 uses tmpfs, DB 15 and a random loopback port; it has no development volume. It destroys only that project after the suite. Individual cases use unique prefixes. TCP proxies gate real replies, disconnect and recover without production injection settings; subprocess tests run the real Node 24 Gateway server. The experimental container runner can reuse its own generated Cart test URL on DB 15 with independent limiter namespaces, without Docker-in-Docker. That reuse branch is implemented but has not been verified in a container-only Phase 15 run. Its pre-existing full-suite limitations remain documented in Phase 14.1; no green container-only full-run claim is made here.

Main Compose Redis has only an explanatory comment change. Existing .env.cart selects host port 6380; existing ports/volumes are unchanged. No Gateway container existed to receive environment mappings, so none is invented or started. Development Redis/business schemas are never reset or migrated by these commands.

## Tested boundaries and deferrals

Tests cover two Gateway instances, 300 competing multi-bucket commands, exact refill accounting, expiry, both directions of partial-spend prevention, proxy chains/IPv6/spoofing, verified and invalid JWTs, all sensitive route groups, no header exemption, secret-free telemetry, outage/recovery/reconnection burst, slow reply, queue saturation, real startup and SIGTERM with pending work. This is functional concurrency evidence, not a production throughput benchmark, physical Redis power-loss durability test or multi-host load test.

Redis Cluster is **not supported**: arbitrary composed IP/user/policy keys do not intentionally share hash tags; Cluster EVAL requires all keys in one slot. A future design must co-locate every composed principal's keys or change the model without losing all-or-none consumption; a single universal tag would concentrate all traffic on one slot. No Cluster client or cross-slot fallback is implemented. Failover/reset can lose rate state and permit a new burst; rate limiting is not durable business idempotency. Global distributed telemetry, adaptive limits, refresh/search policies, IPv6 subnet limits, account lockout, authenticated Gateway service exemptions and production HA/load testing are deferred.
