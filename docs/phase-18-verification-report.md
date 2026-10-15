# Phase 18 verification — 15 October 2026

**INCOMPLETE: dedicated verification and two full regressions remain.** Implementation is in the isolated `phase18/sql-telemetry` worktree and is not committed or pushed. The final feature commit is withheld until required gates pass.

Baseline: current main `c7d7074913853a2b53493da8d5cbfb9cb7065104`, an externally performed PR #3 merge. Its tree is identical to reviewed reconciliation `7281e53`; the local development branch was advanced without changing feature files. Application source remains anchored to verified Phase 17 `e4ed621`. No application merge or main push was performed by Phase 18 work.

[Runbook and boundaries](phase-18-sql-telemetry-runbook.md). [Structured local results](phase-18-verification-results.json). [Reviewed path inventory](phase-18-source-review.json). The new Phase 18 manifest identifies the prospective verification source; previous manifests remain historical and unchanged.

Local gates passed:

- Typecheck and compiled/preloaded runtime smoke.
- 79/79 observability/SQL unit, contract, runtime and security tests (46 new SQL cases; the other 33 retain Phase 17 coverage).
- 50/50 harness tests, including immutable-source and failed benchmark-evidence checks.
- 228/228 existing disabled-focused Gateway, Search, Messaging and rate-limit cases.
- 9/9 real PostgreSQL plan/security/integration tests: restricted role, independent privilege denials, column/table grants, maintenance/grant options/sequence restrictions, safe generic JSON plan retrieval, deterministic real scan/sort/join analysis, bounded lock waits and idle-transaction cleanup.
- All nineteen expressions in eight dashboards passed pinned Prometheus promtool validation.
- Fifteen PostgreSQL benchmark processes, 30,000 measured queries and 1,500 warmups, zero query errors. The owned fixture was removed. Frozen source hashes were checked before/after the final PostgreSQL/performance gates.

The local host has 34 pre-existing containers and approximately 13 GiB swap used. Only one bounded 256 MiB SQL fixture and a separate 128 MiB network-isolated promtool container were started; both were removed. Full store/telemetry-stack runs were not attempted here. Local timings are exploratory under host contention, not a production-capacity or negligible-overhead claim. The final sampled-mode median p95 was 3.311 ms versus 2.843 ms for existing SDK only; throughput was 3,763 versus 4,841 queries/s. Nonmonotonic mode timings demonstrate noise; dedicated measurements remain required. Local enabled benchmark modes used an unavailable loopback exporter; live ingestion/outages and live-Collector performance remain unverified for Phase 18.

One earlier permission-test iteration and one earlier benchmark iteration failed; their retained evidence and the diagnostic correction are described in the structured results. The missing original benchmark-worker detail cannot establish a root cause. Later successes do not erase those attempts.

No raw SQL or parameters are retained by the runtime collector; no caller SQL or values are accepted by diagnostics. No automatic EXPLAIN, index/query modification, production DDL, AI integration or custom frontend was added. Privileged fixture provisioning exists only in the explicitly owned disposable test runner. Database and telemetry credentials remain outside source. Original backend HEAD/index, eight actual environment files and non-documentation application files remain unchanged.

Remaining ordered Linux gates are implemented in `scripts/verify-phase18.mjs`: immutable source/commit and capacity checks; local/static gates; five live business/outage proofs with SQL enabled, actual SQL metric retrieval and all nineteen Grafana queries; real SQL integration and fifteen-process benchmark while the Collector is alive; then two independently provisioned complete regressions. Both must discover the same test count (at least 1,027) with no failed/skipped/unexecuted cases. These have **not** run for Phase 18, and Phase 17's two successful 981-test runs are not substituted.

Publishing a verification candidate, registering the manual workflow on main, and dispatching a run each require separate authorization. A candidate snapshot commit is for CI, not a claim that the final feature is verified; the requested final feature commit remains after successful required gates. No Phase 18 push, main change, dispatch or final feature commit has occurred.
