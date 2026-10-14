# Phase 16.7 — GitHub Actions verification

**PHASE 16.7 STATUS: COMPLETE. Phase 16 is fully verified on commit `f5a3e805424f0cdbb56112fecd95b4bf7906151f`.**

The [final authorized GitHub Actions run 38605646611](https://github.com/Sudiksha-chugh/ecommerce_microservices_v2/actions/runs/38605646611) passed readiness, Messaging host/container, seven targeted Search regressions, **complete Search twice (138/138 each)** and **complete regression twice (948/948 each)**. Both regressions covered all **34 expected test files**. Complete suites had zero failures, skipped/unexecuted cases or failed setup/teardown; owned cleanup and sanitized artifact upload succeeded. All final results belong to this one source revision. Earlier failures remain preserved and are not combined into this pass.

## 1. Starting repository state

Original checkout `backend`, HEAD `e501bc4b9a6ba1e346aa64d9d43da1609c5f455c`, origin `https://github.com/Sudiksha-chugh/ecommerce_microservices_v2.git`. Extensive prior modified/untracked work was preserved; original index had no staged changes. Before-state inventory covers 364 files including actual ignored development env files, plus original index/status. All seven required historical Phase 16 reports and actual runner/workflow/config/discovery/ownership/readiness/report packaging were audited. No new project, reset, application redesign or parallel test framework.

## 2. Runner availability

Public repository API initially found zero workflows/runs; authenticated runner/permission checks were unavailable. No entitlement was invented. After explicit Git/source approvals, existing Git authentication was reused securely and authenticated API confirmed Actions enabled, allowed_actions all and workflow active. Actual standard Ubuntu 24.04 runners executed each authorized manual run. No new account or paid/larger runner was provisioned.

## 3. Runner resource capacity

Final runner `GitHub Actions 1000000711`, `ubuntu-24.04`, Linux Docker, four host/Docker CPUs, 16,766,414,848 bytes total memory (15.61 GiB), 15,260,737,536 bytes available before stores (14.21 GiB), Compose **2.38.2**. Actual capacity floor passed, followed by functional readiness.

One owned project operated at a time. Two PostgreSQL instances, RabbitMQ, Redis, Elasticsearch and Node processes ran with serialized stages. Elasticsearch's unchanged limits: 768 MiB, 256 MiB heap, two CPUs. Planning estimate was 8–12 GiB including build/OS/cache headroom, not measured peak demand. Final store sample: PostgreSQL 406.4 MiB, RabbitMQ 189.5 MiB, Redis 12.52 MiB, Elasticsearch 620.2 MiB, Search PostgreSQL 107.6 MiB. These are final samples, not peaks; disk headroom was not retained. Examined stores were running, not paused/restarting/OOM-killed.

Standard public-runner compute is documented as free; artifact allowance/billing was not measured. Larger runners are charged and were never authorized/provisioned. References: [runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## 4. Source snapshot strategy

Existing snapshot/manifest machinery captures tracked and required untracked implementation, tests, migrations, workspace manifests/lockfile, configs, Docker/test infrastructure, verification scripts/workflow, env examples and Lua runtime asset. Final projection: **315 source/config files plus manifest, 316 total**.

Actual env files, `.secrets`, node_modules, development data/dumps, raw archives and historical reports were excluded. Initially 5,307 ignored files were enumerated. Reviewed source had no live credential material; an env-example private-key-path match referred only to a file path. Required static test identities remain synthetic/disposable. Original omitted Lua asset was later added unchanged with runtime extraction coverage. Copy-time and manifest hash checks reject changed/extra/nonregular selected source.

## 5. Approval decisions

User separately explicitly approved A–D (branch/reviewed commit/public push/one run after prerequisites), E–H (workflow correction and workflow-only main registration commit/push), I–K (Lua correction commit/push/one run), L–N (cursor fixture correction commit/push/one run). Every operation stayed within its scope. Main registration was an explicit exception to the earlier no-main-change rule. No force push, branch merge/deletion, deployment or paid/larger capacity occurred.

Exactly **three agent-triggered manual runs**, each separately authorized: 38601713241, 38603616443, final 38605646611. A separate GitHub-created push-time validation record allocated zero jobs. No automatic expensive reruns or further permissions are needed to report this completed verification. No additional commit/push is performed for this local final report.

## 6. Verification branch

Public `verification/phase16-final`, isolated worktree `/private/tmp/commerce-v2-phase16-7/verification-worktree`, clean at final SHA. Original snapshot staged exact 223 reviewed changed paths using explicit NUL pathspec, never git add -A. Follow-ups staged only their separately reviewed two/four/two paths. Original backend checkout/index remained untouched by Git operations.

## 7. Commit SHA

**Final tested/pushed:** `f5a3e805424f0cdbb56112fecd95b4bf7906151f`, message `Make Search cursor tampering fixtures deterministic`.

**Final source identity:** `e4c195627c715fcad9244f445e5e4ea6e9501dd0399e24c5dfbf23f5cc1a59c1`.

Earlier reviewed source commits `298370ce...` (original), `7f06f96...` (context correction), `7dd36b2...` (Lua packaging correction) remain in branch history. Main registration commit `9f434c53b2c7ab1073a1421778e90c9d7e472d04` adds only the workflow on parent `960bc1ad98e27a0027b8c0bc8c9383a9870942ea`; it is not the application revision under test. Every final committed blob matched its reviewed manifest; checkout/expected GitHub SHA/branch/identity matched the final receipt.

## 8. Workflow configuration

Reused `.github/workflows/phase16-verification.yml`: manual-only dispatch, pinned official actions, Node 24.21.0, npm ci --ignore-scripts, Ubuntu 24.04, read-only contents permission, no persisted checkout credentials, serialized concurrency without cancellation, bounded 180-minute job envelope, existing portable wrapper, always-run sanitization and artifact retention. Production/Vitest/readiness/startup budgets unchanged.

Checkout is pinned to expected_commit; actual HEAD and GitHub SHA must equal it. Source manifest is verified separately. Upload selects only parsed/redacted JSON/JSONL projection, never raw env/source archives; child console output is sanitized. Final receipt hashes:

- Lockfile `e6ffea7ea4134773bc5c6640d7ace7256b1f005ecacab1d6b1971b40c127489c`.
- Workflow `694beac39b161c78d86622e3533159e410db0f4f3494f85912ae6a74b1da51e3`.
- Wrapper `85a8f500ff5adfa13486c4173a828108a8bf16e6db47f760bfb5bf97861198d7`.

GitHub default-branch registration and runner-context restrictions were resolved by separately approved minimal workflow changes; [manual-dispatch requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), [context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts).

## 9. Harness results

Final hosted Node **v24.21.0**, Linux; checkout/locked installation, expected revision/manifest, syntax, strict TypeScript noEmit, **35/35 harness cases**, zero failures/pending cases/failed suites, Compose config and capacity check all passed. Worker JSONL independently records **v24.21.0**. Existing coverage verifies deadlines/readiness failures, ownership/startup, endpoint restoration, first-failure gating, reports/redaction, cleanup and portable runtime assets.

Default application discovery remains apps/**/test/**/*.test.ts and packages/**/test/**/*.test.ts, one worker. The separate harness config does not alter it. Post-run report analysis checked complete-suite filenames against the final manifest: five Search files and all 34 full-regression files, with no missing or extra selected file.

## 10. Infrastructure readiness

**PASSED.** B JSON confirms setup/assertions/cleanup. Existing auth/schema/SELECT PostgreSQL probes, broker confirms/manual delivery/exact probe cleanup, Redis PING, Elasticsearch mapping/index/refresh/alias/production full-text/exact cleanup and fresh/pooled/concurrent/warm latency checks completed. Final image build 24.64 s, functional broker readiness 123.46 ms, Elasticsearch functional child preflight 1.129 s.

Parent sampling across suites: **321 PostgreSQL probes, zero errors**, max query 11.94 ms, max one-second timer gap 1,001.73 ms. Functional readiness, not running-container state alone, gated later tests. No readiness budget or business assertion was enlarged/weakened.

## 11. Messaging results

Host **75/75 passed**, five files. Container **75/75 passed**, five files. Both complete suites executed every discovered case, setup/teardown passed, zero failures/pending cases/failed suites. Independent C JSON reports confirm actual dual-mode endpoint switching/startup. Earlier phase passes are not substituted.

## 12. Targeted Search results

**7/7 passed**, zero failures/failed suites. Covers three fixture teardown regressions, private Catalog DB denial, concurrent-version protection, lost physical-index replay and inbox recovery after Elasticsearch success. D's 80-case file intentionally excludes 73 cases via the allowed targeted selector; they are not counted as passes. All 80 were subsequently executed in both complete Search runs and both full regressions. Filtering occurs only at D.

## 13. Search Run 1

**138/138 passed**, five expected files, zero failed/pending cases or failed suites; setup/teardown passed. Unfiltered E report retained independently.

## 14. Search Run 2

**138/138 passed**, same five files/source revision, zero failed/pending cases or failed suites; setup/teardown passed. Unfiltered F report retained independently. The former cursor-fixture failure is corrected and the two deterministic added cases executed.

## 15. Regression Run 1

**948/948 passed**, all **34 expected service/shared-package test files**, zero failed/pending cases or failed suites, all setup/teardown completed. Default discovery included Search and Messaging; no file selector/exclusion. G report retained independently.

## 16. Regression Run 2

**948/948 passed**, same 34 files/source revision, zero failed/pending cases or failed suites and hooks passed. H report retained independently. No incomplete discovery, filtered case or historical pass is counted toward this result.

## 17. Artifact locations

Final [run 38605646611](https://github.com/Sudiksha-chugh/ecommerce_microservices_v2/actions/runs/38605646611), attempt 1, success, 2026-10-14 **22:49:14–22:56:48 IST**. Artifact `phase16-38605646611-1`, ID **11915835690**, **371,190 bytes**. Sanitization/upload/job finalization passed.

Downloaded reports: `/private/tmp/commerce-v2-phase16-7/cursor-run/artifact-11915835690/phase16-NDLHOV/`; A harness, B readiness, C host/container, D, E/F, G/H, execution and runner/worker JSONL. Post-run validation: `cursor-run/evidence-summary.json`; cleanup inventory/evidence: `cursor-run/cleanup-evidence.json`; preservation and redaction reviews in that folder. Twelve artifact JSON/JSONL files were checked against original development secret values and high-confidence credential patterns; **no findings**. Raw downloaded job logs remain private mode 0600 under `cursor-run/run-logs/`. Blob downloads did not forward GitHub authorization headers.

Earlier failed-run artifacts/logs/API replies/manifests/interim reports remain preserved under the phase temp parent and lua-run folder. No actual env/key/development data upload. Credentials used for API access stayed in process memory, not logs or evidence.

## 18. Confirmed defects and fixes

- GitHub push-time validation rejected job env runner.temp; local YAML syntax checks had missed context semantics. Minimal approved step-env fix resolved it.
- First manual run 38601713241 failed B import because snapshot extension policy omitted required Redis token-bucket.lua; later missing-B-report ENOENT was secondary. Asset was included unchanged and an executable extraction/runtime regression added.
- Second manual run 38603616443 passed through E but F's test could replace first cursor character with the same A. Production decoder was already correct. Fixture now guarantees changed input, retains rejection assertion, adds a changed-input precondition and deterministic valid A/B-prefix vectors. Crypto control is unit-test-only, one-shot; production code/security/deadlines unchanged.

Each source change received new separate commit/push/run approval. Final run freshly passed all gates, without mixing revisions or bypassing a failure.

## 19. Unproven hypotheses

Historical Docker Desktop worker starvation remains historical; no permanent host-pressure cause was claimed fixed. The prior unit fixture failure did not establish a cursor-authentication bypass. Final success establishes these tests/contracts on the approved Linux snapshot; it does not establish deployment correctness, a production load benchmark, universal host suitability or future revision behavior. No speculative application changes were made.

## 20. Files changed

Intentional Phase 16.7 edits: `.github/workflows/phase16-verification.yml`, `scripts/verify-phase16.mjs`, `scripts/verification-snapshot.mjs`, `scripts/verification-harness.mjs`, `scripts/verification-harness.test.mjs`, and `apps/search-service/test/unit.test.ts`. New manifest and this report. Existing Lua source bytes were transferred without modification. Approved source commits also include earlier reviewed Phase 1–16 dirty implementation; those are preserved prior work, not new redesign in this phase.

No production logic, lockfile/dependency, Compose capacity setting, optional-feature default or historical report was modified by this phase's fixes. Final report remains local outside source-commit scope; no additional commit/push.

## 21. Resource cleanup

Final owned project **commerce-v2-stabilization-48bd60040091**. Retained cleanup inventory identifies five stores, seven observed one-off runners, one project network, exact private image and no persistent named volumes (stores use tmpfs). One-offs used --rm and ownership-aware final cleanup; scoped Compose down passed **2.843 s**, exact private-image deletion reported success, runner emitted cleaned_up and exited 0 after generated env/output removal in finally. No cleanup failure or orphan-ownership rejection.

These successful ownership-scoped operations establish completed cleanup; a separate post-removal enumeration was not retained and is not claimed as an independent zero-resource measurement. No unrelated containers/images/networks/volumes were controlled. The hosted project was separate from all original development stores. Evidence/staging worktrees intentionally remain available locally; focused fixture/snapshot temporary directories clean themselves.

## 22. Development data preservation

Final baseline comparison: all **364 existing files remain present**, only six documented intentional existing harness/workflow/unit-test paths changed. Original backend branch/HEAD and index entries are unchanged. Actual development env files match initial hashes; existing Lua and prior implementation/data/Compose/lockfile/historical reports remain preserved, except the explicitly documented test-input correction. No original development SQL/migration/broker/Redis/Elasticsearch operation; no old JavaScript project change. Main's only change is the explicitly authorized workflow registration. Optional defaults remain off.

## 23. Remaining limitations

No required Phase 16.7 verification gate remains pending. Deployment/merge, production sizing and Phase 17 are outside scope and were not performed. Raw interim logs remain local, sanitized CI artifacts expire per seven-day retention and temp files may be removed by the OS; local report records exact source/run/hash identity and artifact locations. No independent post-removal resource enumeration or disk peak measurement was retained; cleanup operations and functional/test evidence are explicit above.

## 24. Final Phase 16 decision

**PHASE 16.7 COMPLETE. Phase 16 can be marked fully verified on `f5a3e805424f0cdbb56112fecd95b4bf7906151f`.** Required runner, authorized exact source transfer, Node 24, harness/readiness, Messaging, seven targeted regressions, Search twice and full regression twice passed on that one revision. Complete suites have zero failures/skips/unexecuted cases and hooks passed; artifacts sanitized, owned cleanup completed, development data/earlier work preserved. All Git/CI changes were expressly authorized. Stop after Phase 16.7; Phase 17 has not begun.
