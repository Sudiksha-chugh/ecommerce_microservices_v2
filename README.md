# ecommerce-microservices-v2

Phase 7: Orders creates and persists owner-scoped order snapshots in `orders_db`. Catalog owns product CRUD and `catalog_db`; Auth owns registration, login, RS256 access tokens, and `auth_db`; Cart owns Redis-backed authenticated carts. Gateway forwards HTTP requests and never connects to PostgreSQL. Public product reads remain unchanged; product writes require an admin JWT. Remaining services are placeholders.

## Requirements and setup

Use Node.js 24 LTS (`.nvmrc`), npm 10+, and Docker with Compose.

```sh
nvm install
nvm use
npm ci
cp .env.example .env
cp .env.auth.example .env.auth
cp .env.cart.example .env.cart
cp .env.orders.example .env.orders
```

Set non-empty `PGPASSWORD` and `CATALOG_TEST_PASSWORD` in `.env`, and independent `AUTH_PGPASSWORD` and `AUTH_TEST_PASSWORD` in `.env.auth`, and `ORDERS_PGPASSWORD` and `ORDERS_TEST_PASSWORD` in `.env.orders`. Passwords have no defaults. All local environment files are ignored by Git. Auth loads only `.env.auth`; Cart loads only `.env.cart`; Orders loads only `.env.orders`; Catalog and Gateway load `.env`. Keep private-key settings and Auth credentials out of `.env`. Compose creates separate development and test databases and roles; test roles cannot connect to development databases.

```sh
npm run db:up
npm run db:provision-auth # repeatable; also required when upgrading an existing Phase 4 volume
npm run db:migrate
npm run db:seed
npm run auth:migrate
npm run db:provision-orders # also required when upgrading an existing volume
npm run orders:migrate
```

Compose runs PostgreSQL 17 and Redis 8, bound to localhost, each with a persistent named volume. Redis uses append-only persistence with fsync every second. Its small Dockerfile copies the test-database initialization script with explicit permissions. Automatic initialization runs only on a fresh volume; `npm run db:provision-auth` also provisions the Auth databases on an existing volume without deleting Catalog data. It skips existing roles/databases and does not reset passwords. Changing `.env` passwords does not change existing database credentials; update them in PostgreSQL when retaining an existing volume. `docker compose stop` stops PostgreSQL while preserving data.

## Environment

Gateway: `HOST=127.0.0.1`, `PORT=3000`, `CATALOG_SERVICE_URL=http://127.0.0.1:4001`, and `CATALOG_REQUEST_TIMEOUT_MS=3000`. The URL must be an HTTP(S) origin without credentials, path, query, or fragment.

Catalog: `CATALOG_HOST=127.0.0.1`, `CATALOG_PORT=4001`, `PGHOST=127.0.0.1`, `PGPORT=5432`, `PGDATABASE=catalog_db`, `PGUSER=catalog_user`, and required `PGPASSWORD`. Zod validates these settings at startup. Pool size defaults to 10 (`PGPOOL_MAX`, maximum 50); connection and query deadlines default to 2000 ms (`PGCONNECT_TIMEOUT_MS`, `PGQUERY_TIMEOUT_MS`). Idle connections close after 10 seconds. `SHUTDOWN_TIMEOUT_MS=10000` bounds graceful HTTP draining and pool closure. `NODE_ENV` defaults to development. Restart after editing `.env`.

For a different local PostgreSQL port change `PGPORT` in `.env` and `AUTH_PGPORT` in `.env.auth`. Gateway settings are validated independently and do not require database credentials.

## Migrations and development seed

Version-controlled migrations live in `apps/catalog-service/migrations`. `npm run db:migrate` runs them in filename order in a transaction, using an advisory lock and `schema_migrations` tracking table. Reruns skip applied files; checksum changes to applied migrations fail. Add a new migration instead of editing an applied one. Schema changes never run automatically on service startup.

`npm run db:seed` inserts Notebook, Coffee mug, and Desk lamp separately from migrations. Stable UUIDs and `ON CONFLICT (id) DO NOTHING` prevent duplicates and preserve existing values on reruns. The development seed is disabled for `NODE_ENV=production`.

The `products` table contains UUID `id` with `gen_random_uuid()` default, required name (VARCHAR 255), description (TEXT), non-negative `BIGINT` `price_in_paise` constrained to JavaScript safe integers, and required `created_at`/`updated_at` timestamps with current-time defaults. PostgreSQL generates UUIDs and insert timestamps; repository updates refresh `updated_at`. Prices remain JSON numbers, including values above the PostgreSQL INTEGER range.

## Run and verify

Run in separate terminals from the project root:

```sh
npm run dev:catalog
npm run dev:auth
npm run dev:cart
npm run dev:orders
npm run dev:gateway
```

Without watch mode, use `npm run start:catalog` and `npm run start:gateway`. `npm run dev` and `npm start` remain gateway aliases. Gateway and Catalog load the root `.env`; Auth loads only `.env.auth`; Cart loads only `.env.cart`; Orders loads only `.env.orders`. Use `npm run start:auth` without watch mode. Generate local keys as documented below before starting Auth, Catalog, Cart, or Orders.

```sh
curl http://127.0.0.1:4001/health
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/products
curl http://127.0.0.1:3000/products/11111111-1111-4111-8111-111111111111
```

Product JSON retains `id`, `name`, `description`, and `priceInPaise`; IDs are now UUIDs. Invalid UUIDs return 400 (`Invalid product ID`), absent UUIDs return 404 (`Product not found`), and Catalog database failures return 503 (`Catalog database unavailable`). Gateway forwards 400/404 responses, maps upstream server/connection failures to 502, and returns 504 for its upstream deadline. Health remains a process liveness check and does not query PostgreSQL. Stop and restart Catalog to verify persisted products survive.

Ctrl+C or SIGTERM drains HTTP requests then closes the pool.

## Product management

All endpoints are available through Gateway on port 3000 or directly through Catalog on port 4001. Writes require `Authorization: Bearer <admin-token>`; missing/invalid tokens return 401 and customer tokens return 403. Public reads require no token. Catalog verifies signatures itself and ignores role headers.

- `POST /products`: creates a product; returns 201, product JSON, and `Location: /products/<uuid>`.
- `PATCH /products/:id`: updates supplied fields; returns 200 with the full updated product.
- `DELETE /products/:id`: returns 204 with an empty body after deletion.
- Existing `GET /products` and `GET /products/:id` retain their response shape.

Creation requires `name`, `description`, and `priceInPaise`. Names are trimmed, non-empty, and at most 255 characters. Description must be a string (empty is allowed). Prices must be non-negative safe integer JSON numbers, up to 9007199254740991; strings and fractions are rejected. Unknown properties are rejected. PATCH uses the same rules, requires at least one field, and preserves omitted fields. Route IDs must be UUIDs.

```sh
curl -i -X POST http://127.0.0.1:3000/products \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mechanical Keyboard","description":"Wireless mechanical keyboard","priceInPaise":499900}'
# HTTP 201; Location: /products/<generated-uuid>
# {"id":"<generated-uuid>","name":"Mechanical Keyboard","description":"Wireless mechanical keyboard","priceInPaise":499900}

# Replace <uuid> with the UUID returned by POST; use a newly created product.
curl -i -X PATCH 'http://127.0.0.1:3000/products/<uuid>' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"priceInPaise":449900}'
# HTTP 200; full product JSON, including priceInPaise: 449900
curl -i -X DELETE 'http://127.0.0.1:3000/products/<uuid>' -H "Authorization: Bearer $ADMIN_TOKEN"
# HTTP 204; no response body
curl -i 'http://127.0.0.1:3000/products/<uuid>'
# HTTP 404; {"error":{"message":"Product not found"}}
```

Invalid product bodies return 400 (`Invalid product body`); malformed JSON returns 400 (`Invalid JSON body`); invalid UUIDs return 400 and missing products return 404. JSON bodies are limited to 100 KB; larger requests return 413. Unexpected write database errors return a sanitized 500 (`Internal server error`) directly from Catalog. Existing GET database-failure behavior remains 503. Gateway preserves successful statuses, 400/404 errors, product bodies, and Location; its existing upstream server/connection error mapping remains 502, with deadline expiry returning 504. Gateway forwards write bodies without parsing or duplicating Catalog validation.

## Tests

Start Compose and provision databases first. Cart tests also require `CART_TEST_REDIS_URL` in `.env.cart`, pointing to Redis database 15. Orders tests require `ORDERS_TEST_PASSWORD` in `.env.orders` and the provisioned `orders_test_db`. Configure `CATALOG_TEST_PASSWORD` in `.env` and `AUTH_TEST_PASSWORD` in `.env.auth`, then:

```sh
npm run typecheck
npm test
npm run test:watch
```

Catalog tests use real PostgreSQL, hardcode the test database/role, validate the connected identity, and create a random schema per run. Migrations and deterministic seed fixtures run inside that schema; cleanup drops only that schema. Tests ignore development `PGDATABASE`, `PGUSER`, and `PGPASSWORD` and verify test credentials cannot connect to `catalog_db`. CRUD tests cover create/update/delete, validation, timestamps, safe-integer boundaries, parameterized text values, and sanitized write failures. Gateway tests cover methods, exact JSON body forwarding, Location, 204 bodies, and write-request failures/timeouts. They fail if PostgreSQL or test credentials are absent rather than silently skipping. Coverage includes health, listing, UUID lookup, absent/invalid IDs, real query failures, migration/seed repeatability, UUID/timestamp defaults, and the price constraint. Gateway tests preserve HTTP forwarding/failure coverage with a repository fixture, independently of PostgreSQL.

Auth tests use the restricted `auth_test_user` role with `auth_test_db` and an isolated schema per run. Tests never use development Auth credentials. Signing keys are generated in memory, so tests do not read local private keys. Coverage includes registration validation, duplicate races, password hashing, login, JWT claims/signatures/expiry, deleted users, Catalog authorization, gateway headers/statuses, and database isolation. Existing CRUD tests now use valid ephemeral admin tokens.

## Authentication setup and keys

Generate a local 3072-bit RSA key pair from the project root once. Do not overwrite keys in use: replacing the verification key invalidates existing tokens. These paths are ignored by Git.

```sh
mkdir -p .secrets
chmod 700 .secrets
# Stop if either file already exists; use existing keys instead of overwriting them.
test ! -e .secrets/auth-private.pem && test ! -e .secrets/auth-public.pem && \
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out .secrets/auth-private.pem
chmod 600 .secrets/auth-private.pem
openssl pkey -in .secrets/auth-private.pem -pubout -out .secrets/auth-public.pem
```

Set matching `JWT_ISSUER`, `JWT_AUDIENCE`, and `JWT_PUBLIC_KEY_FILE` in `.env` and `.env.auth`. Key file paths are relative to each service workspace, so the examples use `../../.secrets/auth-public.pem`. Only `.env.auth` contains `AUTH_JWT_PRIVATE_KEY_FILE=../../.secrets/auth-private.pem`. Auth imports its PKCS#8 private key and SPKI public key, checks that they match at startup, and signs RS256 tokens. Catalog imports only the public key. In deployment, run services with distinct identities and mount only the public key into Catalog; the shared local workspace is a development setup.

Auth defaults: `AUTH_HOST=127.0.0.1`, `AUTH_PORT=4000`, `AUTH_PGHOST=127.0.0.1`, `AUTH_PGPORT=5432`, `AUTH_PGDATABASE=auth_db`, `AUTH_PGUSER=auth_user`. Password is required. Pool size defaults to 10, idle timeout to 10 seconds, and connection/query deadlines to 2000 ms; configure `AUTH_PGPOOL_MAX`, `AUTH_PGCONNECT_TIMEOUT_MS`, and `AUTH_PGQUERY_TIMEOUT_MS`. Startup and migrations reject a superuser or any role that can connect to `catalog_db`. Graceful shutdown drains HTTP requests then closes the pool. Auth database errors return generic 500 responses.

Gateway uses `AUTH_SERVICE_URL=http://127.0.0.1:4000` and `AUTH_REQUEST_TIMEOUT_MS=3000`. It forwards methods, bodies, Authorization, status, Content-Type, Cache-Control, and WWW-Authenticate. Auth connection failures return 502 and deadlines return 504; Auth HTTP responses, including sanitized 500 errors, retain their status. Existing Catalog server-error mapping remains unchanged.

## Registration, login, and current user

```sh
curl -i http://127.0.0.1:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"SecurePassword123!"}'
# HTTP 201: {"id":"<uuid>","email":"user@example.com","role":"customer"}

TOKEN=$(curl -sS http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"SecurePassword123!"}' \
  | node -e 'process.stdin.on("data", d => process.stdout.write(JSON.parse(d).accessToken))')
# Login response: {"accessToken":"<signed-jwt>","tokenType":"Bearer","expiresIn":900}
curl -i http://127.0.0.1:3000/auth/me -H "Authorization: Bearer $TOKEN"
# HTTP 200: public user {id,email,role}; no password hash
```

Registration rejects unknown fields, validates email (maximum 255 characters), trims and lowercases it, and requires a 12–128 character password. Role is always `customer`; supplying `role` is rejected. Passwords are hashed with argon2id (64 MiB memory, three iterations, one lane) and independently salted. A unique index on `LOWER(email)` handles duplicates, including concurrent registrations, with 409. Login validates strict bodies, normalizes email, verifies the hash, and returns the same 401 `Invalid credentials` for unknown users and incorrect passwords. Unknown-user login still performs an argon2 verification against an ephemeral dummy hash. Passwords, hashes, and tokens are never logged.

JWTs contain only subject UUID, role, issuer, audience, issued-at, and expiry. `JWT_ACCESS_TOKEN_TTL_SECONDS` defaults to 900 and accepts 60–3600. Verification permits RS256 only and requires subject, role, issued-at, expiration, matching issuer/audience, and a valid signature. `/auth/me` loads the current user from `auth_db`, so deleted users are rejected and current role information is returned. Catalog verifies the signed claims locally without calling Auth or trusting unverified gateway headers.

Catalog's JWT role claims can remain valid until expiry after user deletion or a role change. This phase has no refresh tokens or immediate revocation mechanism.

## Explicit local admin bootstrap

Set `AUTH_BOOTSTRAP_EMAIL` and a 12–128 character `AUTH_BOOTSTRAP_PASSWORD` in ignored `.env.auth`, then run:

```sh
npm run auth:bootstrap-admin
```

This is a CLI-only local development action and is disabled for `NODE_ENV=production`. It creates a new admin with an argon2id hash. It never promotes an existing customer or changes an existing admin password; reruns for an existing admin leave it unchanged. There is no public admin-registration endpoint. Login as that admin through `/auth/login`, then put the returned token in `ADMIN_TOKEN` for the product-write examples above. Remove bootstrap password settings from `.env.auth` when finished if you do not need to repeat the command. Use distinct local customer/admin accounts.

See [ADR 003](docs/adr/003-authentication-and-authorization.md) for security and ownership decisions.

## Redis and Cart Service

Run `npm run db:up` to start both infrastructure services, or `npm run redis:up` to start only Redis. Redis data lives in the `cart_redis_data` named volume. `docker compose --env-file .env --env-file .env.auth --env-file .env.orders stop redis` preserves carts. No orders, checkout, prices, inventory reservations, or Catalog/Auth database access is part of Cart.

```sh
npm run redis:up
npm run dev:cart
# Or without watch mode:
npm run start:cart
```

Cart defaults to `http://127.0.0.1:4002`. `.env.cart` contains:

- `CART_HOST=127.0.0.1`, `CART_PORT=4002`.
- `CART_REDIS_URL=redis://127.0.0.1:6379/0` (Redis/rediss URL; credentials supported).
- `CART_TEST_REDIS_URL=redis://127.0.0.1:6379/15` (tests require database 15).
- `CART_TTL_SECONDS=604800` (seven days, configurable from 1 to 31536000 seconds).
- `CART_REDIS_CONNECT_TIMEOUT_MS=2000`, `CART_REDIS_COMMAND_TIMEOUT_MS=2000`.
- `CATALOG_SERVICE_URL=http://127.0.0.1:4001`, `CATALOG_REQUEST_TIMEOUT_MS=2000`.
- `JWT_PUBLIC_KEY_FILE=../../.secrets/auth-public.pem`, matching `JWT_ISSUER` and `JWT_AUDIENCE` from Auth.
- `SHUTDOWN_TIMEOUT_MS=10000` and `NODE_ENV=development`.

Only the public verification key is configured in Cart; no private key or PostgreSQL credentials are loaded. Every cart endpoint verifies the JWT independently. The owner is the verified UUID subject, canonicalized to lowercase. Role may be customer or admin. User IDs in headers are ignored; user IDs or other unexpected body fields are rejected.

Gateway settings in `.env`: `CART_SERVICE_URL=http://127.0.0.1:4002`, `CART_REQUEST_TIMEOUT_MS=3000`. Methods, JSON bodies, Authorization, response statuses, and relevant headers are forwarded. Cart responses are marked `Cache-Control: no-store`.

If port 6379 is occupied, set `CART_REDIS_PORT=6380` in `.env` and change both Redis URLs in `.env.cart` to port 6380 before starting infrastructure/tests. This workspace uses 6380 locally to leave the pre-existing port-6379 service untouched. Changing the container port alone does not update service URLs.

## Cart API and storage

All cart endpoints require `Authorization: Bearer <valid-token>`. Use a customer token from `/auth/login` in `TOKEN`.

```sh
curl http://127.0.0.1:3000/cart -H "Authorization: Bearer $TOKEN"
# HTTP 200: {"items":[]}
curl -X POST http://127.0.0.1:3000/cart/items \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"productId":"11111111-1111-4111-8111-111111111111","quantity":2}'
# HTTP 200: {"items":[{"productId":"11111111-1111-4111-8111-111111111111","quantity":2}]}
# Repeating POST increments the existing quantity.
curl -X PATCH http://127.0.0.1:3000/cart/items/11111111-1111-4111-8111-111111111111 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"quantity":3}'
# HTTP 200: updated cart; unspecified items preserved
curl -i -X DELETE http://127.0.0.1:3000/cart/items/11111111-1111-4111-8111-111111111111 \
  -H "Authorization: Bearer $TOKEN"
# HTTP 204, empty body; 404 if the item was absent
curl -i -X DELETE http://127.0.0.1:3000/cart -H "Authorization: Bearer $TOKEN"
# HTTP 204; safe to repeat on an empty cart
```

POST accepts exactly `productId` (UUID, canonicalized to lowercase) and `quantity` (integer 1–99). PATCH accepts exactly `quantity` with the same limits. Invalid bodies/IDs or an increment above 99 return 400. Product existence is checked through Catalog's public GET API before each POST; an absent product returns 404, Catalog connection/server failures return 502, and Catalog deadlines return 504. PATCH requires an existing cart item and never creates one. Missing/invalid/expired JWTs return 401. Reads return only product UUIDs and quantities, with items sorted by product UUID; prices are never stored or calculated.

Each owner has a Redis hash `cart:{<user-uuid>}` with product UUID fields and integer quantities. Lua scripts perform increment/limit checks, quantity replacement or removal, and TTL refresh atomically. POST/PATCH return the cart snapshot from that same script, so concurrent additions cannot lose updates or exceed 99. Removing the last item deletes the hash. Clearing deletes the entire owner key.

Successful POST, PATCH, and item removal refresh the TTL on any remaining cart. Reads and failed mutations never extend it. Clearing or removing the last item leaves no key to expire. Expired or absent carts read as an empty items array when Redis is healthy. Initial Redis connection attempts and commands have bounded deadlines; disconnected storage returns a sanitized 503 (`Cart storage unavailable`), never an empty cart. Gateway preserves this 503; an unavailable Cart HTTP service itself returns 502 and gateway timeouts return 504. Offline queuing is disabled; Cart reconnects in the background after a runtime disconnect. Redis errors, credentials, and tokens are not logged. A timed-out mutation may already have executed: inspect the cart before retrying an increment. Append-only persistence with fsync every second can lose recent writes during a hard crash.

JWT account/role changes are subject to the same token-expiry limitation documented for Catalog; Cart does not call Auth per request. Product existence is checked on addition, without inventory reservations or cross-service transactions.

Cart integration tests run against real Redis database 15 with a random namespace, ephemeral JWTs, and a local Catalog HTTP fixture. They delete only their own keys, never flush Redis, and never modify Catalog products. Tests cover authentication, user isolation, strict validation, CRUD, dependency failures, concurrent additions/limits, TTL refresh/expiry, and case-insensitive UUID identity. Gateway tests verify all Cart routes and 503/502/504 behavior. Run `npm run typecheck` and `npm test` after starting infrastructure.

See [ADR 004](docs/adr/004-redis-carts.md) for the Redis design.

## Orders Service

Orders runs independently on port 4003. It verifies JWTs with the public key, reads the authenticated cart through HTTP using the caller's JWT, fetches current Catalog product details, and persists immutable item snapshots. It has no Redis, Auth database, Catalog database, or private signing key access. Orders does not clear carts in Phase 7.

```sh
# Copy .env.orders.example to .env.orders and supply independent passwords first.
npm run db:up
npm run db:provision-orders # safe on an existing volume; creates missing databases/roles
npm run orders:migrate
npm run dev:orders
# Without watch mode:
npm run start:orders
```

Provisioning/migrations do not delete existing data. The version-controlled migration is `apps/orders-service/migrations/001-orders.sql`; the runner follows the same transaction, advisory lock, filename, and checksum tracking conventions as Catalog/Auth. No startup schema synchronization is performed.

Orders settings in `.env.orders`: `ORDERS_HOST=127.0.0.1`, `ORDERS_PORT=4003`, `ORDERS_PGHOST=127.0.0.1`, `ORDERS_PGPORT=5432`, `ORDERS_PGDATABASE=orders_db`, `ORDERS_PGUSER=orders_user`, and required `ORDERS_PGPASSWORD`. Test credentials use `ORDERS_TEST_PASSWORD`. Pool maximum defaults to 10 (`ORDERS_PGPOOL_MAX`), connection/query deadlines to 2000 ms (`ORDERS_PGCONNECT_TIMEOUT_MS`, `ORDERS_PGQUERY_TIMEOUT_MS`), idle timeout to 10 seconds, and graceful shutdown to 10000 ms. Startup and migrations reject superusers and roles that can connect to `auth_db` or `catalog_db`. If PostgreSQL uses another host port, update `ORDERS_PGPORT` as well as the other service files.

Set `CART_SERVICE_URL=http://127.0.0.1:4002`, `CATALOG_SERVICE_URL=http://127.0.0.1:4001`, `CART_REQUEST_TIMEOUT_MS=2000`, and `CATALOG_REQUEST_TIMEOUT_MS=2000`. These deadlines cover receiving headers and reading complete JSON bodies. Catalog lookups run concurrently for at most 100 distinct cart items, each with its own deadline. Unsupported cart sizes return 422. Cart data must contain valid unique UUIDs and quantities 1–99; invalid upstream data is rejected rather than treated as empty. `JWT_ISSUER`, `JWT_AUDIENCE`, and `JWT_PUBLIC_KEY_FILE` must match Auth's public-key settings. Only public-key configuration belongs in this file.

Gateway uses `ORDERS_SERVICE_URL=http://127.0.0.1:4003` and `ORDERS_REQUEST_TIMEOUT_MS=10000` in `.env`. It forwards methods, Authorization, Idempotency-Key, query parameters, bodies, status codes, and relevant response headers. It never connects to `orders_db`.

## Order API

All three endpoints require a valid Bearer JWT; admin and customer accounts can access only their own orders. User identity comes from the verified subject, never body fields or identity headers.

```sh
# Add a product to the authenticated customer's cart first.
curl -X POST http://127.0.0.1:3000/cart/items \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"productId":"11111111-1111-4111-8111-111111111111","quantity":2}'

curl -i -X POST http://127.0.0.1:3000/orders \
  -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: checkout-request-123'
# HTTP 201; Location: /orders/<uuid>
# {"id":"<uuid>","userId":"<customer-uuid>","status":"PENDING","totalAmountInPaise":29800,
#  "createdAt":"<timestamp>","updatedAt":"<timestamp>","items":[
#    {"productId":"11111111-1111-4111-8111-111111111111","productName":"Notebook",
#     "unitPriceInPaise":14900,"quantity":2,"lineTotalInPaise":29800}]}

curl 'http://127.0.0.1:3000/orders?limit=20&offset=0' -H "Authorization: Bearer $TOKEN"
# HTTP 200: {"orders":[<order summaries>],"limit":20,"offset":0}
curl 'http://127.0.0.1:3000/orders/<uuid>' -H "Authorization: Bearer $TOKEN"
# HTTP 200: full order and persisted items; another user's UUID returns 404
```

POST accepts no body or `{}` only. Products, quantities, prices, totals, and owner IDs cannot be supplied in the order body. `Idempotency-Key` is required, case-sensitive, 1–255 characters, starts with an ASCII letter/digit, and contains only letters, digits, `.`, `_`, `:`, or `-`. History pagination defaults to limit 20/offset 0, permits limit 1–100 and offset 0–1000000, and rejects unknown/repeated/invalid parameters. Ordering is `created_at DESC, id DESC`. Lists return summaries; individual retrieval and creation return the full stored item snapshots.

Errors: 401 for missing/invalid/expired JWT, 400 for invalid keys/body/UUID/pagination, 404 for absent or another user's order, 409 for competing same-key first attempts with different snapshots, 422 for empty carts, missing products, excessive cart size, or unsupported monetary totals, 502 for dependency failures/invalid responses, 504 for dependency deadlines, and sanitized 500 for internal/database errors. Gateway preserves Orders responses and adds 502/504 for an unavailable/timed-out Orders HTTP service. Response bodies consistently use `{error:{message}}` and expose no SQL, credentials, or stack traces.

## Order storage, money, transactions and idempotency

`orders` stores a generated UUID, authenticated `user_id`, PENDING-only constrained status, BIGINT total, idempotency key, snapshot fingerprint, and timestamp defaults. It enforces unique `(user_id, idempotency_key)` and indexes owner/date/id for deterministic history. `order_items` stores generated UUIDs, the order foreign key with cascading delete, product UUID/name, BIGINT unit/line amounts, and positive quantity. Product IDs are snapshots without cross-database foreign keys. Unique `(order_id, product_id)` also provides an order-id-leading index. SQL checks non-negative/safe-range amounts and line-total consistency.

Money is integer paise. Calculations use JavaScript `bigint`, not floating-point multiplication or addition. Amounts are returned as JSON numbers only within 0–9007199254740991. PostgreSQL BIGINT values are selected as decimal text and explicitly range-checked before conversion; no global pg type parser or floating-point SQL cast is used. Unsupported line/order totals are rejected before persistence.

Creation acquires one pool client, performs BEGIN, inserts the order, bulk-inserts all item snapshots with parameterized arrays, and COMMITs. Any error ROLLBACKs; finally releases the client, discarding it if rollback fails. This prevents a persisted header without its required items. Upstream calls happen before the transaction. No automatic HTTP mutation retries are added.

A key names one immutable checkout attempt for one authenticated user. Completed keys are looked up **before** Cart/Catalog requests and always replay the original full order with 201 and its original Location, even if the cart/prices changed or dependencies are now unavailable. No current-cart fingerprint is recomputed on this replay path. To start a new checkout, generate a **new key**; a different key may deliberately create a second order from an unchanged cart.

For a fresh key, the checkout snapshot consists of product UUIDs, original product names, authoritative unit prices, cart quantities, computed line totals, and final total. Canonically sorted items plus a version marker are SHA-256 hashed into `request_fingerprint`. Database uniqueness is the final race guard. If first attempts overlap, the losing transaction rolls back/releases its client, then loads the winning order. Identical snapshots replay it; different snapshots return 409. Thus a completed retry and competing first attempts have distinct semantics. Because the valid POST body carries no checkout data, it cannot distinguish an intentional new checkout from a retry using a completed key: clients must use a new key for new intent.

Cart contents and Catalog products remain unchanged. Persisted names/prices/totals are used for historical reads, so later Catalog changes cannot rewrite past orders. Cart clearing, inventory reservations, and payments require later checkout orchestration and are deliberately absent. JWTs retain the existing until-expiry account-change limitations.

Orders integration tests use real `orders_test_db` as `orders_test_user`, validate identity, migrate into a random schema, and drop only that schema. They use ephemeral JWT keys and local Cart/Catalog HTTP fixtures, so development carts/products/orders are untouched. Coverage includes atomic rollback, database constraints/failures, exact money boundaries, ownership, pagination, idempotent concurrency and conflicts, changed-cart replays, and bounded dependency failures. Run `npm run typecheck` and `npm test` after starting infrastructure and provisioning all test databases. See [ADR 005](docs/adr/005-orders-and-idempotency.md).

## Layout and scope

- `apps/api-gateway`: HTTP forwarding, health, timeouts, and tests.
- `apps/catalog-service`: product API, public-key authorization, repository, migrations, and database tests.
- `apps/auth-service`: authentication business logic, user repository, RS256 signing, migrations, admin CLI, and tests.
- `apps/cart-service`: authenticated cart routes, Catalog HTTP client, atomic Redis repository, lifecycle, and tests.
- `apps/orders-service`: authenticated order creation/history, snapshot business logic, PostgreSQL transactions, migrations, and tests.
- `packages/security`: shared public-key JWT verification; no signing or private-key access.
- `packages/config`: Zod environment validation.
- `packages/contracts`: shared JSON types.
- `compose.yaml` and `infrastructure/docker`: local PostgreSQL and Redis.
- `docs/adr/002-postgresql-access.md`: raw SQL decision.

OAuth, Auth0, refresh tokens, password reset, email verification, RabbitMQ, inventory, payments, ORM, Kubernetes, and remaining service implementations are outside this phase. Checkout, product price calculations, and inventory reservations are also deferred. Saga orchestration, transactional outbox, and refunds are deferred. Work stops at Phase 7.
