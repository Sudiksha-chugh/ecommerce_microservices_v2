# ADR 003: Authentication ownership and local JWT authorization

Status: Accepted (Phase 5)

## Context

Auth must own account registration/login independently of Catalog. Product reads remain public, but product writes need a verified admin identity. Gateway routing must not become the security boundary or gain database access.

## Decision

Auth owns `auth_db`, its migration history, a dedicated non-superuser database role, and password hashes. Catalog continues owning `catalog_db`; Auth startup and migration commands reject database roles that can connect to Catalog. Separate restricted test databases and random schemas isolate integration tests. Database-level `LOWER(email)` uniqueness handles registration races; database role constraints support only customer/admin.

Passwords use argon2id with independent salts, 64 MiB memory, three iterations, and one lane. This supplies memory-hard password hashing; plaintext passwords are never stored or logged. Registration is strict, normalizes email, and always creates a customer. Login uses a generic invalid-credentials response and a dummy hash verification for unknown users. Admin bootstrap is an explicit non-production CLI action, never an HTTP endpoint, and never silently promotes a customer.

Auth signs RS256 access tokens using jose and a configurable private key. Asymmetric signing lets Catalog verify without access to signing capability. Tokens carry only UUID subject, role, issuer, audience, issued-at, and expiration. Verification pins RS256 and validates required claims, signature, issuer, audience, and expiry. Startup checks Auth's configured key pair matches. Private keys/configuration are ignored by Git and kept out of Catalog's environment file; production deployments must use separate identities and public-key-only mounts for Catalog.

A small shared security package implements verification only. Catalog verifies tokens independently at write endpoints, requiring admin role, without an Auth request per product write. Gateway forwards Authorization, never supplies trusted role headers, and owns no authentication business logic. Auth's service layer is justified by password hashing, login verification, token issuance, and current-user lookup; no extra controllers are needed for the small route surface.

`/auth/me` reloads a user by the verified subject to reject deleted accounts and return current information. Auth responses are non-cacheable and return no hashes. Gateway preserves Auth HTTP errors while retaining existing Catalog upstream error mapping.

## Consequences and limits

Catalog role claims remain valid until token expiry after account or role changes. Access tokens default to 15 minutes; refresh tokens and immediate revocation are outside this phase. Key replacement invalidates previous tokens; multi-key rotation is deferred. The shared local workspace is not an OS-level process sandbox: deploy private keys only to Auth in production. Separate PostgreSQL databases maintain ownership without requiring another infrastructure service. Schema changes remain explicit migrations.

References: [node-argon2](https://github.com/ranisalt/node-argon2), [jose JWT verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md), [jose JWT signing](https://github.com/panva/jose/blob/main/docs/jwt/sign/classes/SignJWT.md).
