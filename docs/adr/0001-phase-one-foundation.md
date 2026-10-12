# ADR 0001: Lightweight TypeScript workspace foundation

Status: Accepted

## Context

We need a maintainable starting point for seven services without implementing their domains or introducing infrastructure prematurely.

## Decision

Use private npm workspaces, Node.js 24 LTS, Express 5, and a shared strict NodeNext TypeScript configuration. Keep runtime dependencies local to the workspace that uses them. Use Zod for startup configuration and Vitest with Supertest for HTTP integration tests.

Use ESM and tsx to run TypeScript directly in development and local start scripts. Internal packages export their TypeScript source. A compiled production artifact and deployment pipeline are deferred; `npm start` currently requires installed development tooling. This avoids introducing a build orchestrator during foundation work.

Use an application factory separate from the listening process. Keep environment validation in a reusable package with a gateway-specific schema. Share only public response contracts. Reserve other service workspaces without runnable scripts or dependencies.

## Consequences

One lockfile provides repeatable installs, while workspace manifests make dependency ownership explicit. Strict checking covers all present TypeScript files. Service boundaries remain visible without unnecessary runtime dependencies. Later deployment work must establish a build strategy and operational readiness checks; the current health route is liveness only.
