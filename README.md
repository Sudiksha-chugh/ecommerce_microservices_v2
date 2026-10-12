# ecommerce-microservices-v2

Phase 9: Payments owns payment intents, durable attempts, and reconciliation in `payments_db`. Its durable mock provider owns a separate database. Inventory owns stock and atomic, expiring reservations in `inventory_db`. Orders creates and persists owner-scoped order snapshots in `orders_db`. Catalog owns product CRUD and `catalog_db`; Auth owns registration, login, RS256 access tokens, and `auth_db`; Cart owns Redis-backed authenticated carts. Gateway forwards HTTP requests and never connects to PostgreSQL. Public product reads remain unchanged; product writes require an admin JWT. Remaining services are placeholders.

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
cp .env.inventory.example .env.inventory
cp .env.payments.example .env.payments
cp .env.mock-provider.example .env.mock-provider
```

Set non-empty `PGPASSWORD` and `CATALOG_TEST_PASSWORD` in `.env`, and independent `AUTH_PGPASSWORD` and `AUTH_TEST_PASSWORD` in `.env.auth`, and `ORDERS_PGPASSWORD` and `ORDERS_TEST_PASSWORD` in `.env.orders`. Set independent `INVENTORY_PGPASSWORD` and `INVENTORY_TEST_PASSWORD` in `.env.inventory`. Set `PAYMENTS_PGPASSWORD` / `PAYMENTS_TEST_PASSWORD` in `.env.payments` and `MOCK_PGPASSWORD` / `MOCK_TEST_PASSWORD` in `.env.mock-provider` independently. Passwords have no defaults. All local environment files are ignored by Git. Auth loads only `.env.auth`; Cart loads only `.env.cart`; Orders loads only `.env.orders`; Inventory loads only `.env.inventory`; Catalog and Gateway load `.env`. Keep private-key settings and Auth credentials out of `.env`. Compose creates separate development and test databases and roles; test roles cannot connect to development databases.

```sh
npm run db:up
npm run db:provision-auth # repeatable; also required when upgrading an existing Phase 4 volume
npm run db:migrate
npm run db:seed
npm run auth:migrate
npm run db:provision-orders # also required when upgrading an existing volume
npm run orders:migrate
npm run db:provision-inventory # required when upgrading an existing volume
npm run inventory:migrate
npm run db:provision-payments
npm run payments:migrate
npm run mock-provider:migrate
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
npm run dev:inventory
npm run start:mock-provider
npm run dev:payments
npm run dev:gateway
```

Without watch mode, use `npm run start:catalog` and `npm run start:gateway`. `npm run dev` and `npm start` remain gateway aliases. Gateway and Catalog load the root `.env`; Auth loads only `.env.auth`; Cart loads only `.env.cart`; Orders loads only `.env.orders`. Use `npm run start:auth` without watch mode. Generate local keys as documented below before starting Auth, Catalog, Cart, Orders, or Inventory.

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

Run `npm run db:up` to start both infrastructure services, or `npm run redis:up` to start only Redis. Redis data lives in the `cart_redis_data` named volume. `docker compose --env-file .env --env-file .env.auth --env-file .env.orders --env-file .env.inventory --env-file .env.payments --env-file .env.mock-provider stop redis` preserves carts. No orders, checkout, prices, inventory reservations, or Catalog/Auth database access is part of Cart.

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

Cart contents and Catalog products remain unchanged. Persisted names/prices/totals are used for historical reads, so later Catalog changes cannot rewrite past orders. Orders does not invoke Inventory yet; cart clearing and payments require later checkout orchestration. JWTs retain the existing until-expiry account-change limitations.

Orders integration tests use real `orders_test_db` as `orders_test_user`, validate identity, migrate into a random schema, and drop only that schema. They use ephemeral JWT keys and local Cart/Catalog HTTP fixtures, so development carts/products/orders are untouched. Coverage includes atomic rollback, database constraints/failures, exact money boundaries, ownership, pagination, idempotent concurrency and conflicts, changed-cart replays, and bounded dependency failures. Run `npm run typecheck` and `npm test` after starting infrastructure and provisioning all test databases. See [ADR 005](docs/adr/005-orders-and-idempotency.md).

## Inventory Service (Phase 8)

Inventory runs independently on port 4005, owns `inventory_db` with a non-superuser `inventory_user`, and checks product existence through Catalog HTTP when stock is initialized or replaced. It never reads other service databases. Gateway only forwards HTTP. Orders and Cart do not call Inventory in this phase; inventory is not automatically created when Catalog products are created.

Copy `.env.inventory.example` to `.env.inventory`, set independent development/test passwords, and retain matching JWT issuer, audience, and public key settings. Inventory loads only this file and never imports the private signing key. Run:

```sh
npm run db:up
npm run db:provision-inventory
npm run inventory:migrate
npm run start:inventory # or npm run dev:inventory
npm run start:gateway
npm run typecheck
npm test
```

Provisioning is repeatable and preserves existing volumes/data. Fresh volumes provision all service and mock-provider databases automatically. Migrations use a checksum-tracked `schema_migrations` table and an advisory transaction lock; they run explicitly, never as automatic schema synchronization. Inventory integration tests hardcode `inventory_test_db` / `inventory_test_user`, assert the connection identity, migrate into a random schema, and drop only that schema. The test role is denied access to all development databases. `INVENTORY_TEST_PASSWORD` is required for tests.

Environment defaults in `.env.inventory.example`:

- `INVENTORY_HOST=127.0.0.1`, `INVENTORY_PORT=4005`.
- `INVENTORY_PGHOST=127.0.0.1`, `INVENTORY_PGPORT=5432`, owning `INVENTORY_PGDATABASE=inventory_db`, `INVENTORY_PGUSER=inventory_user`, required `INVENTORY_PGPASSWORD`.
- Pool maximum 10 (`INVENTORY_PGPOOL_MAX`, limit 50); connection and query deadlines 2000 ms (`INVENTORY_PGCONNECT_TIMEOUT_MS`, `INVENTORY_PGQUERY_TIMEOUT_MS`), idle timeout 10 seconds.
- `CATALOG_SERVICE_URL=http://127.0.0.1:4001`, `CATALOG_REQUEST_TIMEOUT_MS=2000`.
- `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_PUBLIC_KEY_FILE` match Auth; only the public key is needed.
- `RESERVATION_TTL_SECONDS=900` (1–604800), `EXPIRATION_WORKER_INTERVAL_MS=5000` (50–60000), `EXPIRATION_WORKER_BATCH_SIZE=100` (1–500), `SHUTDOWN_TIMEOUT_MS=10000`.

Gateway `.env` uses `INVENTORY_SERVICE_URL=http://127.0.0.1:4005` and `INVENTORY_REQUEST_TIMEOUT_MS=10000`. All settings are validated with Zod. For another PostgreSQL host port, update Inventory and Orders port settings alongside Catalog/Auth.

Endpoints are available directly on 4005 and through Gateway on 3000:

- `GET /health`: process liveness, without database dependency (direct service endpoint).
- `GET /inventory/:productId`: public stock only; 200 with `{productId,totalStock,reservedStock,availableStock}`.
- `PUT /inventory/:productId`: admin-only absolute replacement of unconsumed `totalStock`; 200 with stock. This is not an increment. Catalog must contain the product; reductions below reserved stock return 409.
- `POST /inventory/reservations`: admin-only; 201 with an order reservation group, including on identical replay.
- `POST /inventory/reservations/:orderId/confirm`: admin-only; 200 with confirmed group, including stable repeated confirmation.
- `POST /inventory/reservations/:orderId/release`: admin-only; 200 with released group, including stable repeated release.

```sh
# Set PRODUCT_ID to an existing Catalog UUID and ORDER_ID to a new UUID.
curl -X PUT "http://127.0.0.1:3000/inventory/$PRODUCT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"totalStock":10}'
# {"productId":"<uuid>","totalStock":10,"reservedStock":0,"availableStock":10}
curl "http://127.0.0.1:3000/inventory/$PRODUCT_ID"
curl -X POST http://127.0.0.1:3000/inventory/reservations \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"orderId\":\"$ORDER_ID\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":2}]}"
# 201: {"orderId":"<uuid>","status":"RESERVED","expiresAt":"<ISO timestamp>",
#       "items":[{"id":"<reservation uuid>","productId":"<uuid>","quantity":2,
#                 "status":"RESERVED","expiresAt":"<same ISO timestamp>"}]}
curl -X POST "http://127.0.0.1:3000/inventory/reservations/$ORDER_ID/confirm" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 200, status CONFIRMED; totalStock=8, reservedStock=0, availableStock=8.
# For another RESERVED order, use /release; totalStock remains unchanged.
```

UUIDs normalize to lowercase. Stock and quantities are JSON integers within PostgreSQL INTEGER bounds (0–2147483647 for stock, 1–2147483647 for quantities). A reservation requires 1–100 items, unique normalized product IDs, and an order UUID. Unknown fields are rejected. Confirm/release accept no body or an empty JSON object. Missing/invalid JWTs return 401; customer JWTs return 403. Every write verifies the RS256 signature, issuer, audience, expiration, and UUID subject independently. User-supplied service headers never grant privileges. Secure internal service identity is deferred until checkout integration; reservation access is admin-only now.

`inventory` enforces non-negative total/reserved stock and `reserved_stock <= total_stock`. `total_stock` means stock not yet consumed by confirmed reservations; available stock is always `total_stock - reserved_stock`. Reserving 3 of 10 yields 10/3/7. Confirming yields 7/0/7; releasing yields 10/0/10. The reservation ledger has generated UUIDs, positive quantities, constrained statuses, unique order/product pairs, timestamps, and only local foreign keys. Indexes support status/expiry, order, and product lookups. `inventory_reservation_requests` stores the durable whole-order fingerprint and serialization row.

Transactions first lock the order request and then all stock rows in sorted product UUID order. All items are checked before writes; any failure rolls back stock, rows, and fingerprint together. A versioned SHA-256 fingerprint of the sorted normalized product/quantity set makes concurrent identical requests one logical result. Replays preserve reservation IDs and expiry, return the current stored status, and never reserve again, even after terminal states. Changed quantities, added/removed/replaced products for the same order return 409. A failed initial request leaves no fingerprint and can be retried after availability is fixed.

Allowed transitions are RESERVED → CONFIRMED, RELEASED, or EXPIRED. Repeated confirmation/release returns the same persisted result; incompatible terminal transitions return 409. Confirmation rechecks the PostgreSQL clock after stock locks are acquired, so lock waits cannot permit late confirmation. A late confirm/release commits expiration and releases stock, then returns 409. Replay does not revive an expired group.

The worker polls persisted deadlines, claims order request rows with `FOR UPDATE SKIP LOCKED`, locks all affected stock rows in sorted order, and expires complete groups atomically. Multiple service instances cannot release the same stock twice or race a confirmation incorrectly. No in-memory timer defines reservation expiry: the timer only schedules database scans. Worker logs contain counts or generic failures. Shutdown stops scheduling, waits for its active transaction, drains HTTP, and closes the pool. Expired reservations may remain counted as reserved until a worker scan or a late transition expires them; public GET never mutates stock. Batch limits and the interval determine cleanup latency.

Errors: 400 invalid input, 401 invalid/missing token, 403 customer, 404 absent product/inventory/reservation, 409 insufficient stock or incompatible replay/state, 502 unavailable Catalog, 504 Catalog deadline, and sanitized 500 database/internal failures. Gateway preserves these responses and returns 502/504 for Inventory connection/deadline failures.

Tests cover real database constraints and rollback, whole-order idempotency, final-unit contention, many simultaneous reservations, reversed multi-product lock ordering, concurrent stock replacement, confirmation/release races, expiry after lock waits, multiple workers, worker shutdown/failure logging, independent JWT checks, and gateway byte/header/status forwarding. See [ADR 006](docs/adr/006-inventory-reservations.md).

## Payments Service (Phase 9)

Payments runs on 4004 and owns `payments_db`; the durable mock provider runs on 4006 and owns `mock_provider_db`. Both use restricted non-superuser roles and separate environment files. No existing orders, inventory, or carts are changed by Payments. Order totals are supplied only by authorized admins for this phase; checkout will derive authoritative amounts later. Reservation orchestration and real payment providers remain deferred.

```sh
cp .env.payments.example .env.payments
cp .env.mock-provider.example .env.mock-provider
# Set independent development/test passwords in both files.
npm run db:up
npm run db:provision-payments # required for an existing volume; repeatable
npm run payments:migrate
npm run mock-provider:migrate
# Separate terminals:
npm run start:mock-provider
npm run start:payments # or dev:payments
npm run start:gateway
npm run typecheck
npm test
```

All Compose scripts now load `.env`, `.env.auth`, `.env.orders`, `.env.inventory`, `.env.payments`, and `.env.mock-provider`; copy/configure each example before starting infrastructure. Provisioning preserves existing roles/databases and volumes, does not reset passwords, and denies test roles access to development databases. Payments migrations are checksum-tracked and explicitly applied. The provider schema is version controlled and initialized explicitly; neither server synchronizes schemas at startup.

Payments configuration in `.env.payments`: owning `PAYMENTS_PGDATABASE=payments_db`, `PAYMENTS_PGUSER=payments_user`, required password, host/port defaults 127.0.0.1/5432, `PAYMENTS_HOST=127.0.0.1`, `PAYMENTS_PORT=4004`. Pool maximum defaults to 10 (`PAYMENTS_PGPOOL_MAX`, maximum 50); connection/query deadlines default to 2000 ms (`PAYMENTS_PGCONNECT_TIMEOUT_MS`, `PAYMENTS_PGQUERY_TIMEOUT_MS`), idle timeout 10 seconds. JWT issuer/audience/public-key path must match Auth; no private key is loaded. `MOCK_PROVIDER_URL=http://127.0.0.1:4006`, `PROVIDER_REQUEST_TIMEOUT_MS=2000`, `PAYMENT_LEASE_MS=10000` (must exceed the provider deadline), `RECONCILIATION_INTERVAL_MS=5000`, `RECONCILIATION_BATCH_SIZE=10`, `SHUTDOWN_TIMEOUT_MS=10000`. Gateway `.env` uses `PAYMENTS_SERVICE_URL=http://127.0.0.1:4004` and `PAYMENTS_REQUEST_TIMEOUT_MS=10000`.

The provider loads only `.env.mock-provider`: owning `MOCK_PGDATABASE=mock_provider_db`, `MOCK_PGUSER=mock_provider_user`, required password, `MOCK_PGHOST=127.0.0.1`, `MOCK_PGPORT=5432`, `MOCK_HOST=127.0.0.1`, `MOCK_PORT=4006`, `MOCK_DELAY_MS=3000`. `MOCK_SCENARIO` selects `success`, `decline`, `timeout` (charge commits, then response is delayed), `temporary-failure` (definitive failure), `lost-response` (charge commits, then socket closes), or `ambiguous` (unresolved durable operation). Restart the provider after changing its scenario; saved operations remain unchanged. No scenario/header override is accepted from callers. Keep this local simulator bound to loopback; it is not a real/public provider.

Endpoints through Gateway 3000 or directly on Payments 4004:

- `POST /payments/intents`: admin-only, required visible ASCII `Idempotency-Key` of 1–255 characters. Strict JSON requires order/user UUIDs, positive safe integer `amountPaise`, and `currency: "INR"`. Returns 201 and Location, including on identical replay. Keys are scoped to the authenticated admin; changed input returns 409. PostgreSQL additionally enforces one payment per order and unique owner/key pairs.
- `POST /payments/:paymentId/process`: admin-only, no body or `{}`. Returns current payment, 202 when another caller holds an active processing claim, otherwise 200. It commits a durable attempt before calling the provider. Repeated processing never creates another charge; uncertain results require reconciliation.
- `POST /payments/:paymentId/reconcile`: admin-only, no body or `{}`. Queries the original provider operation, returns 200; CREATED payments return 409. Repeated/concurrent reconciliation is safe.
- `GET /payments/:paymentId`: authenticated; admins can read any payment, customers only their own. Unauthorized/nonexistent records return 404. Public JSON contains paymentId, orderId, status, amountPaise, currency, without provider metadata.
- `GET /health` directly on 4004: process liveness.

```sh
curl -i -X POST http://127.0.0.1:3000/payments/intents \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Idempotency-Key: phase9-example-1' \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"11111111-1111-4111-8111-111111111111","userId":"22222222-2222-4222-8222-222222222222","amountPaise":50000,"currency":"INR"}'
# 201: {"paymentId":"<uuid>","orderId":"<uuid>","status":"CREATED","amountPaise":50000,"currency":"INR"}
curl -X POST "http://127.0.0.1:3000/payments/$PAYMENT_ID/process" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST "http://127.0.0.1:3000/payments/$PAYMENT_ID/reconcile" -H "Authorization: Bearer $ADMIN_TOKEN"
curl "http://127.0.0.1:3000/payments/$PAYMENT_ID" -H "Authorization: Bearer $CUSTOMER_TOKEN"
```

States: CREATED → PROCESSING → SUCCEEDED / FAILED / REQUIRES_RECONCILIATION. Uncertain payments reconcile to SUCCEEDED / FAILED, or remain uncertain. Terminal states cannot restart or change outcome. Process/reconcile on a terminal payment return its stored result. A lease token fences stale HTTP responses after recovery. The stable provider request ID is persisted on attempt 1 and is never replaced. The mock commits in another database, independently of Payments' local transaction, and uniquely stores request IDs/amounts/currency. Provider retries therefore cannot create a second charge.

Network timeout, provider unavailability, invalid provider data, or a missing provider result remain uncertain; they are never proof that no charge occurred. Reconciliation only queries, never recharges. A provider operation that stays absent/unknown remains REQUIRES_RECONCILIATION until a definitive result or a future operator policy; automatic replacement charging is deliberately absent. Definitive temporary failures are terminal in this single-attempt phase. The bounded worker polls due candidates, claims each under a row lock and database-clock lease, and retries lookups with persisted scheduling. Multiple workers cannot claim an active lease. Graceful shutdown stops scheduling and drains work before pool closure. These guarantees depend on provider idempotency and do not claim exactly-once network delivery.

Errors: 400 invalid input, 401 missing/invalid JWT, 403 customer write attempts, 404 absent/unauthorized payment, 409 conflicting intent or invalid transition, and sanitized 500 internal/database failures. Provider ambiguity is represented in payment state. Gateway preserves status/body/Authorization/Idempotency-Key/Location and returns 502/504 for service connection/deadline failures.

Tests require `PAYMENTS_TEST_PASSWORD` and `MOCK_TEST_PASSWORD`, use distinct hardcoded restricted test databases, validate connected identities, and create/drop random schemas. They never mutate development payments or provider operations. Coverage includes unit/state/validation tests, creation/processing/reconciliation races, independent JWT/ownership checks, provider scenarios, real PostgreSQL rollback/constraints, and an actual process killed after a provider commit then restarted twice to verify one durable charge. See [ADR 007](docs/adr/007-payments-and-reconciliation.md).

## Layout and scope

- `apps/api-gateway`: HTTP forwarding, health, timeouts, and tests.
- `apps/catalog-service`: product API, public-key authorization, repository, migrations, and database tests.
- `apps/auth-service`: authentication business logic, user repository, RS256 signing, migrations, admin CLI, and tests.
- `apps/cart-service`: authenticated cart routes, Catalog HTTP client, atomic Redis repository, lifecycle, and tests.
- `apps/payments-service`: payment intents, attempts, leases, reconciliation worker, public-key authorization, migrations, and an independently persisted mock provider.
- `apps/inventory-service`: stock, reservations, PostgreSQL transactions, Catalog HTTP client, public-key admin authorization, expiration worker, migrations, and tests.
- `apps/orders-service`: authenticated order creation/history, snapshot business logic, PostgreSQL transactions, migrations, and tests.
- `packages/security`: shared public-key JWT verification; no signing or private-key access.
- `packages/config`: Zod environment validation.
- `packages/contracts`: shared JSON types.
- `compose.yaml` and `infrastructure/docker`: local PostgreSQL and Redis.
- `docs/adr/002-postgresql-access.md`: raw SQL decision.

OAuth, Auth0, refresh tokens, password reset, email verification, RabbitMQ, real payment gateways, ORM, Kubernetes, and remaining service implementations are outside this phase. Checkout orchestration, transactional outbox, and refunds are deferred. Work stops at Phase 9.
