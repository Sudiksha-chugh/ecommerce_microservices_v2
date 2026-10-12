# ADR 005: Orders ownership, snapshots and idempotent creation

Status: Accepted (Phase 7)

## Context

Orders must turn an authenticated owner's cart into an authoritative historical record without sharing Auth/Catalog databases or Redis. HTTP retries and concurrent requests must not produce duplicate purchases. Payments, inventory reservations, and checkout orchestration are deferred.

## Decision

Orders owns `orders_db` and its migrations through a dedicated non-superuser role denied access to `auth_db` and `catalog_db`. Tests use a separate restricted database/role and random schemas. Orders validates JWTs independently with the public key and scopes every lookup/list/key to the verified owner. Gateway only forwards HTTP methods, bodies, headers and query parameters.

The server fetches Cart through HTTP with the caller's verified JWT, then fetches current Catalog product information. At most 100 unique cart products are supported per checkout, each with positive quantity up to Cart's limit of 99. Dependency failures are explicit 502/504 errors, empty carts and missing products return 422, and invalid responses never become empty data.

Names, unit prices, quantities, line totals and final total are stored as immutable checkout snapshots. Historical reads never consult current Catalog data. Monetary arithmetic uses bigint, and PostgreSQL BIGINTs are read as text with explicit safe-range checks before producing JSON numbers. SQL constraints enforce non-negative safe-range amounts and line-total consistency. Values outside JavaScript's safe JSON integer range are rejected rather than rounded.

A single checked-out PostgreSQL client performs BEGIN, the header INSERT, one parameterized bulk item INSERT, and COMMIT. Failures ROLLBACK and finally release the client, discarding broken clients. Remote HTTP reads happen before the transaction; there is no distributed transaction or automatic mutation retry.

Every POST requires a user-scoped idempotency key and has no body or an empty object only. A key denotes one immutable checkout attempt. Completed attempts replay the stored order before any remote reads, including after the cart changes. A new checkout requires a new key.

For first attempts, a versioned canonical snapshot (sorted product UUIDs, names, unit prices, quantities, line totals, total) is SHA-256 hashed. Unique `(user_id, idempotency_key)` protects concurrent inserts. A unique-key loser rolls back/releases its client before loading the committed winner, including when the pool has size one. Equal snapshots replay the winner; different concurrent first-attempt snapshots return 409. Fingerprints are not recomputed from changed carts for completed retries. Since no client checkout data is accepted, a completed key cannot express distinct new checkout intent; reuse always means retry.

Cart clearing is absent: a later checkout workflow must coordinate payment/reservations and clear appropriately. Orders currently has only PENDING status. No cross-database foreign keys, ORM, outbox, saga, broker, payment, inventory, or refund features are added.

## Consequences and limits

Retries can recover from an ambiguous HTTP/COMMIT outcome with the same key; new keys intentionally create new orders even for the same cart. A concurrent price/cart change can yield 409, while a completed retry always returns its original result. Product reads are authoritative at retrieval time but are not an inventory reservation or a cross-service consistent snapshot. JWT account changes retain the existing until-expiry limitation. Pagination uses bounded offsets and deterministic date/UUID ordering. Future checkout orchestration, statuses, and revocation require separate phases.

References: [node-postgres transactions](https://node-postgres.com/features/transactions), [node-postgres type handling](https://node-postgres.com/features/types), [PostgreSQL numeric types](https://www.postgresql.org/docs/17/datatype-numeric.html).
