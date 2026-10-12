# ADR 002: Catalog PostgreSQL access with raw SQL and pg

Status: Accepted (Phase 3)

## Context

Catalog must persist products independently while preserving the gateway HTTP boundary. The initial scope consists of listing and lookup, so an ORM or generic persistence framework would add complexity without a current need.

## Decision

Catalog owns `catalog_db` and uses node-postgres (`pg`) with one bounded pool. Product Repository contains explicit SQL and parameterizes lookup values. SQL aliases preserve the camelCase HTTP product shape. Routes validate UUIDs, call the repository, and map database errors to a sanitized 503; the gateway has no database dependency.

Version-controlled SQL migrations are explicit commands, tracked by filename and SHA-256 checksum. A transaction and advisory lock protect repeatability and concurrent runners. Development seed data is separate and idempotent through stable UUID primary keys. PostgreSQL supplies UUID and timestamp defaults and enforces non-negative prices.

Tests connect as a restricted role to `catalog_test_db`, create a unique schema, migrate and seed it, and drop it after testing. The test role cannot connect to `catalog_db`. Local PostgreSQL uses a persistent Docker volume; credentials come from environment variables without password defaults.

## Consequences

SQL and schema changes remain visible and reviewable. We own migrations and row mapping and must add new migration files for schema evolution. Health checks remain liveness checks. Timestamps default on insert; future update paths must explicitly maintain `updated_at`. Deployment credentials, production TLS, and write APIs are outside this phase.

References: [node-postgres pool API](https://node-postgres.com/apis/pool), [PostgreSQL UUID functions](https://www.postgresql.org/docs/17/functions-uuid.html).
