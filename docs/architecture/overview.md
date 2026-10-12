# Phase 7 architecture

This npm workspace monorepo keeps independently owned services together with shared TypeScript tooling. API Gateway listens on port 3000; Catalog Service listens on port 4001. Auth Service listens on port 4000; Cart Service listens on port 4002; Orders Service listens on port 4003. Remaining application folders are placeholders.

## Service boundaries

- API Gateway: HTTP entry point, product request forwarding, upstream deadlines and error mapping.
- Catalog: product information and its own PostgreSQL database, `catalog_db`.
- Auth: registration, login, password hashing, JWT signing, current-user lookup, and its own `auth_db`.
- Cart: authenticated temporary product references and quantities in its own Redis hashes.
- Orders: owner-scoped order snapshots, exact totals, history, and idempotent transactional creation in `orders_db`.
- Inventory and Payments: deferred.

Runtime services do not import another application's internals. Gateway communicates with Catalog exclusively through HTTP and has no PostgreSQL connection. Catalog routes call Product Repository; that repository owns parameterized raw SQL and uses a bounded node-postgres pool. Database failures return a sanitized 503, mapped by Gateway to 502. Product IDs are UUIDs. Zod product schemas validate create/partial-update bodies in Catalog. Repository methods implement INSERT RETURNING, partial UPDATE RETURNING with timestamp refresh, and DELETE RETURNING. No service layer is needed for the current CRUD rules. Gateway forwards write methods and raw JSON bodies with status, Content-Type, and Location preservation. New write database errors return a sanitized 500; GET failure behavior remains unchanged.

`packages/contracts` contains shared transport types. `packages/config` validates each service's environment independently with Zod. Catalog and Auth validate independent database settings. Auth loads its separate `.env.auth` file. Only Auth imports the private key; Catalog loads the public key and independently verifies admin JWTs before product writes. Product reads remain public. `packages/security` contains verification only.

`createApp()` wires routes and error middleware; Catalog receives its repository explicitly. `server.ts` owns settings, listening, pool construction, and signal handling. `/health` indicates process liveness. Shutdown drains HTTP requests, then closes the pool within a configurable deadline.

Compose runs PostgreSQL and Redis with separate persistent volumes. Cart stores only product UUIDs and quantities in owner-scoped hashes; Lua scripts provide atomic mutations, limits, and TTL refresh. Cart checks products through Catalog HTTP and independently verifies JWTs with the public key; it has no PostgreSQL connection or private-key configuration. Redis failures return 503 instead of an empty cart. Catalog migrations are explicit, transactional commands tracked by checksums; development seeds run separately and are idempotent. Test credentials access only `catalog_test_db`; database integration tests use a random schema per run. Gateway tests use an HTTP Catalog fixture without requiring database access.

Orders uses HTTP for Cart/Catalog reads and never accesses their stores. It verifies public-key JWTs independently, leaves carts unchanged, and uses one PostgreSQL client/transaction for order headers and items. Completed idempotency keys replay before upstream reads; canonical snapshot fingerprints distinguish competing first attempts. Monetary arithmetic uses bigint and guarded conversion to safe JSON numbers.

See [ADR 005](../adr/005-orders-and-idempotency.md) for Orders decisions.

See [ADR 004](../adr/004-redis-carts.md) for Redis cart decisions.

See [ADR 003](../adr/003-authentication-and-authorization.md) for authentication and authorization decisions.

See [ADR 002](../adr/002-postgresql-access.md) for PostgreSQL access decisions. OAuth, caches, brokers, inventory, payments, refresh tokens, and remaining services are outside Phase 7.
