# ADR 004: Owner-scoped carts in Redis

Status: Accepted (Phase 6)

## Context

Carts contain temporary product references and quantities, need fast owner-specific access, and naturally expire. Catalog remains the sole product source, and Cart must not connect to PostgreSQL or calculate prices.

## Decision

Cart is an independent service on port 4002. It verifies RS256 JWTs locally with the public key, issuer, audience, expiry, and UUID subject through the shared verifier. The owner comes exclusively from verified claims; body/header owner IDs are never trusted. No private signing keys or database credentials are configured in Cart.

Redis is the Cart-owned store. A hash `cart:{<user-uuid>}` maps canonical product UUIDs to quantities; it represents the required lookup/update structure without duplicating product metadata or prices. UUIDs are normalized to lowercase to avoid distinct keys for equivalent UUIDs. The official base node-redis client supplies the required core commands without unrelated Redis modules.

POST checks product existence through Catalog HTTP before storage, then increments a quantity. PATCH only replaces an existing cart quantity. Quantities are integers from 1 to 99. Lua scripts atomically check limits/existence, mutate the hash, refresh TTL, and return the updated snapshot. An application-level read followed by write would lose updates under concurrent additions; a single script also prevents increments exceeding the limit. Removal uses a script, and clear uses atomic DEL. Scripts access only one owner's key.

Carts expire seven days after a successful mutation by default; TTL is configurable. GET and failed mutations do not refresh it. Removing the last item or clearing removes the key. Local Redis uses a dedicated persistent volume with append-only writes and fsync every second.

Redis startup and commands have bounded deadlines. Offline queues are disabled, errors are sanitized, and disconnected Redis returns 503 rather than an empty cart. Runtime connections reconnect in the background. Only healthy storage can report an absent/expired cart as empty. Gateway forwards this 503 while using 502 for a disconnected Cart HTTP service and 504 for gateway deadlines. Catalog failures are bounded and return 404/502/504 as appropriate.

Tests use Redis database 15 plus a unique key namespace. Cleanup deletes only test-owned keys, never FLUSHDB/FLUSHALL. JWT keys are ephemeral, Catalog is an HTTP fixture, and development carts/products are untouched.

## Consequences and limits

Cart references are checked on addition only; there is no product snapshot, reservation, checkout, or cross-service transaction. JWTs may remain usable until expiry after account changes. A Redis command timeout does not prove that the mutation did not execute, so clients should inspect the cart before retrying an increment. Append-only fsync every second provides persistence but may lose the last second of writes on a hard crash. Redis database indexes/namespaces are test isolation, not a production access-control boundary; production service credentials and deployment isolation remain separate concerns.

References: [Redis Lua scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/), [node-redis](https://github.com/redis/node-redis).
