# Phase 16.6 — dedicated verification report

**PHASE 16.6 STATUS: INCOMPLETE. RUNNER PREPARATION: COMPLETE locally. PHASE 16 FULLY VERIFIED: NO.**

No dedicated runner or authorized transfer mechanism exists. The user explicitly confirmed this. Portable preparation and local control-path verification are complete; Linux execution, infrastructure responsiveness, both Messaging modes, targeted Search, both complete Search runs and both full regression runs remain unexecuted in Phase 16.6. No runtime success is inferred from harness tests or previous reports.

## 1. Starting repository state

Continued the existing dirty working tree, including the earlier Search teardown/setup fixes, owned integration runner and Phase 16.2–16.5 reports. There are extensive modified and untracked application, test and infrastructure files. No reset, checkout, rebase, commit, push or Phase 17 work occurred. A before-state SHA256 inventory covers 356 existing files, including ignored actual development env files; retained at `/private/tmp/commerce-v2-phase16-6/before.json` with starting Git status. All historical reports remain unchanged.

## 2. Actual Node.js runtime

Local static/harness/preparation checks used **v24.21.0**, the native binary at `/private/tmp/commerce-v2-stabilization/node-v24.21.0-darwin-arm64/bin/node`. The original host default Node 22.23.3/npm 10.9.9 installation was not replaced. Portable code has no dependency on this temporary Node path. The integration Dockerfile and manual workflow pin Node 24.21.0. Node 24 is enforced by both entry points. No Linux Node runtime or container execution was verified in this phase.

## 3. Available runner environments

Only the local Darwin machine with Docker Desktop was found. Docker context discovery found `desktop-linux` and the local `default` socket context, not a remote Linux daemon. SSH is installed, but no host/access details are available; `gh` is absent. The existing GitHub remote cannot independently transfer uncommitted/untracked work. The user's response was: “No existing runner or transfer mechanism.” Read-only Docker context discovery was approved; no provisioning, upload or remote execution was attempted.

## 4. Selected runner and rationale

Prepared a portable Linux runner and manual Ubuntu 24.04 workflow draft. Neither is currently available as an executing dedicated environment. A sufficiently provisioned dedicated Linux machine is preferred because earlier local Docker Desktop runs showed worker starvation and later control-plane delays. This is an environment-selection rationale, not proof that Linux fixes the Search failures. The overloaded local host was not used for another heavy run.

## 5. Resource requirements

The candidate plan is roughly 16 GiB host/Docker memory and at least four Docker CPUs. Entry point checks require Linux, four Docker CPUs, at least 14 GiB Docker memory and eight GiB host `MemAvailable`. These are planning floors, not measured peak requirements; functional Gate B must still prove responsiveness. Two PostgreSQL instances, RabbitMQ, Redis, Elasticsearch, image build and Node workers/subprocesses need OS/cache reserve. Estimate 8–12 GiB usable envelope including reserve. Elasticsearch's existing 768 MiB container cap, 256 MiB heap and two-CPU cap are unchanged. Earlier host evidence (16 GiB RAM, approximately 10.2 GiB swap use, Docker 7.75 GiB, 34 unrelated containers) is historical, not a fresh utilization measurement. Hosted-runner capacity differs by repository/runner class; see the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). No paid capacity was allocated.

## 6. Portability changes

Added an entry point that resolves the repository from its own file location, a source-only archive/manifest builder, and dependency-independent harness config. Extracted testable controls into shared runner helpers. Generated endpoint rewrites retain credentials and feature flags, touch only the owned temporary env directory and restore after failure. The archive includes dirty/untracked source and required root configs, lockfiles and Dockerfiles; actual env files/data and historical reports are omitted. `COPYFILE_DISABLE=1` prevents macOS AppleDouble metadata becoming spurious test files on extraction. Manifest verification detects altered or additional selected source files. Detailed operating instructions are in `docs/phase-16-verification-runner.md`.

## 7. Verification entry point

`node scripts/verify-phase16.mjs --prepare-only` runs type checking and all harness cases/hooks, checks Compose availability and validates only the disposable integration Compose config. It does not start stores. `node scripts/verify-phase16.mjs` additionally requires the Linux capacity floor before delegating to the existing ownership-aware integration runner. Expected snapshot identity can be supplied as `PHASE16_SOURCE_IDENTITY`; mismatch/missing source fails before runtime gates. `PHASE16_EVIDENCE_DIR` selects the parent of a unique, nonoverwriting evidence directory.

Ordered stages: A static/harness; B representative setup/store latency/fixture cleanup; C complete Messaging host then container; D seven targeted Search regressions; E/F complete Search twice; G/H default full regression twice; I owned cleanup. Each stage has independent JSON, plus bounded runner/worker JSONL. Nonzero status, missing/invalid reports, skipped full-suite cases or failed hooks stop subsequent gates. Targeted selector exclusions are limited to D. No application timeout was increased.

## 8. CI workflow changes

Added `.github/workflows/phase16-verification.yml`: manual dispatch only, fixed serialized concurrency without cancellation, Ubuntu 24.04 candidate, Node 24.21.0, locked `npm ci --ignore-scripts`, read-only contents permission, no persisted checkout credentials, same entry point and `always()` JSON/JSONL artifact retention. Official release commits are pinned; references are in the operator guide. YAML syntax was parsed locally with Ruby YAML; no hosted workflow was installed or run. Expected source identity is required. A current branch checkout without the dirty-tree manifest fails rather than falsely verifying this working tree. This draft needs a later authorized exact-source delivery mechanism; no secret/source upload occurred. The 180-minute job envelope is not a change to test/startup/readiness budgets.

## 9. Harness validation results

Latest portable extracted-source preparation **passed** under Node v24.21.0: TypeScript noEmit, **31/31 harness tests**, zero failed/skipped cases or failed suites, isolated Compose config validation and Docker Compose version **5.5.1**. All seven new/changed JavaScript modules/configs passed Node syntax checks; Git whitespace check passed. Harness config does not alter application integration discovery.

Coverage includes confirm/manual-ACK broker readiness, wrong payload, cancellation, lost connection, confirm and delivery deadlines, stuck close, partial topology and cleanup failures; no stale ACK and cleared timers; actual host/container startup guards; selective owned startup parsing and bounded observer output; endpoint restoration after stage/restore failures; first-failure gate stopping and independent reports; false-green skipped/hook report rejection; redacted evidence; partial startup cleanup, foreign ownership refusal and missing owned resources; source snapshot overwrite refusal, omission of development env files, unexpected-source/tamper detection and AppleDouble exclusion.

Evidence chronology is retained, not overwritten:

- Initial focused extraction tests: 27 passed; expanded local entry point: 30 passed; added snapshot test: 31 passed.
- First extracted-source attempt failed type checking because a shared `node_modules` symlink pointed workspace packages at the original checkout. Validation dependency wiring was corrected, with no source changes for that problem.
- Second attempt passed type checking and 31 cases but failed a spurious AppleDouble test suite. Archive metadata generation was fixed and regression coverage added.
- Final extracted-source attempt: 31/31 cases, typecheck and Compose validation passed; execution record says preparation complete, integration unexecuted.

Final source archive: `/private/tmp/commerce-v2-phase16-6/source-final.tar.gz`; **314 source/config files**; manifest identity `f35ebba97ecbbdde0c125bcaed3e7338aba26efe85d72a3ed6006467794ec08d`. Final evidence: `/private/tmp/commerce-v2-phase16-6/portable-check/phase16-ZIjgdt/A-harness.json` and `execution.json`. Source was extracted into a separate local directory. Existing dependencies were reused with workspace links pointing into that extracted directory; fresh Linux `npm ci`, dependency downloads and image build are unexecuted. This local check demonstrates source/path packaging and control paths, not Linux integration success.

## 10. Infrastructure responsiveness

**UNEXECUTED in Phase 16.6.** Only CLI availability/config validation occurred; no new containers or stores were started. Historical Phase 16.5 owned startup took 21.14 seconds, authenticated AMQP handshake 334 ms and broker functional readiness about 3.7 seconds, but later health checks/control-plane calls timed out and Elasticsearch preflight did not complete. These initial successes did not prove sustained responsiveness; the previous run was stopped and its owned resources cleaned. Gate B must establish a fresh responsive Linux baseline before any Messaging/Search/full suite.

## 11. Messaging host results

**UNEXECUTED.** New ordered plan explicitly launches the complete host suite at C before the container comparison. Earlier 16.4's 75/75 result is historical and is not a current gate pass.

## 12. Messaging container results

**UNEXECUTED.** Startup timeout now follows the actual per-stage mode, including container execution within a host-oriented session. Local fake-timer coverage passed, but actual container behavior is unverified. Earlier 16.4's 75/75 is historical only.

## 13. Targeted Search results

**UNEXECUTED.** D selects the existing seven teardown/database-boundary/version/replay/inbox regressions and validates exactly seven passing cases. Selector exclusions are allowed only in this targeted gate. Historical 16.4 had four passes and three failures; subsequent cleanup corrections never completed fresh verification. No assertions were weakened.

## 14. Complete Search Run 1

**UNEXECUTED.** E contains no selector and must pass every discovered case, setup and teardown with no pending cases.

## 15. Complete Search Run 2

**UNEXECUTED.** F is a distinct full run and report, launched only after E passes.

## 16. Full regression Run 1

**UNEXECUTED.** G uses default application/package discovery without file exclusions or selectors. No current regression counts are claimed.

## 17. Full regression Run 2

**UNEXECUTED.** H uses the same unfiltered discovery and an independent report, launched only after G passes.

## 18. Confirmed defects

The original container-start guard depended on the outer session's host flag, allowing a switched container stage to bypass its start deadline. Shared guard now uses the actual execution mode. Functional broker readiness needed a deadline covering delivery and cleanup and timer clearing on synchronous publish errors; these controls now have executable failure coverage. A one-off cleanup error previously prevented later owned-image cleanup; all owned cleanup phases are now attempted and aggregated. Admin close failure no longer bypasses owned cleanup. Retained stage reports now reject false green pending/hook failures and redact credentials. The real extracted-copy check additionally confirmed the macOS tar metadata portability defect, now fixed. These are harness defects/corrections; they do not establish resolution of the integration teardown failure.

## 19. Unproven hypotheses

An adequately provisioned Linux runner may avoid the local scheduling/control-plane behavior, but this is unproven. Historical worker `/proc` scheduler evidence supports substantial runnable waiting; swap/unrelated container load alone does not establish causation. A responsive broker handshake alone does not establish sustained broker/store/worker responsiveness. Search setup and teardown corrections remain unverified against fresh runtime gates. No application logic was redesigned based on these hypotheses.

## 20. Exact files changed in Phase 16.6

Existing files intentionally amended: `.gitignore` (only local evidence ignore), `package.json` (only two verification scripts), `scripts/integration-runner.mjs` (shared controls/order/report validation/cleanup), `scripts/integration-startup-observer.mjs` (shared selective parsing and injectable focused controls).

New files: `scripts/verification-harness.mjs`, `scripts/verification-harness.test.mjs`, `scripts/verify-phase16.mjs`, `scripts/verification-snapshot.mjs`, `vitest.harness.config.mjs`, `.github/workflows/phase16-verification.yml`, `docs/phase-16-verification-runner.md`, and this report. New local evidence files are ignored. Preexisting dirty application/test/Compose/example-env changes were retained and were not part of Phase 16.6 edits. No dependencies or lockfile were changed in this phase.

## 21. Resource cleanup evidence

No Docker resources were created in Phase 16.6, so there is no new owned infrastructure to remove. Harness fake ownership tests verified all cleanup attempts after partial startup, refusal to delete foreign labels, benign absent resources, exact owned image deletion and temporary removal after errors. Real local fixture/snapshot staging directories are removed by their finally/afterEach paths; archive/evidence/extracted-source validation artifacts were deliberately retained locally. Historical Phase 16.5 cleanup confirmed zero resources for its owned project. No unrelated containers/images/networks/volumes were stopped or removed. Actual Linux Gate I remains unexecuted; fake cleanup coverage is not a runtime ownership audit.

## 22. Development data preservation

The 356-file baseline comparison found **no missing files** and changes in only the four intentional existing harness/config files above. Actual development env files, application sources/tests, Compose definitions, lockfile and historical reports match their initial hashes. This phase did not start stores, execute SQL or change any development database/volume/broker/Redis/Elasticsearch data. No application optional-feature defaults or production enablement changed. Original host Node installation and Docker configuration remain unchanged.

## 23. Approval restrictions

No existing runner or transfer mechanism is available or authorized. Remote source upload, workflow installation/dispatch, host/account/cloud provisioning and paid resources were not attempted. This is an availability/authorization gap, not an automatic-review rejection or denied escalation. User instructions prohibit commit/push and further phases; those restrictions were respected. Only an explicitly authorized runner and exact-source transfer can unlock runtime verification.

## 24. Remaining risks

Linux dependency installation, image build and all real runtime gates remain untested. Capacity thresholds are planning safeguards and cannot replace Gate B. The manual workflow needs an exact-source manifest delivered through a future authorized mechanism and may reject an undersized hosted runner. Abrupt runner loss can prevent graceful cleanup; a later audit must use exact owned names/labels. The portable archive intentionally omits dev env/data, docs and prior evidence and cannot be treated as a complete backup. Review it before any future transfer. All failed preparation evidence is retained with its error context.

## 25. Final Phase 16 verification decision

**Phase 16.6 is INCOMPLETE. Portable RUNNER PREPARATION is COMPLETE; Phase 16 cannot be marked fully verified.** Infrastructure, Messaging host/container, seven targeted Search cases, complete Search twice, full regression twice and real cleanup verification require an available authorized dedicated Linux runner containing this exact source snapshot. None is inferred passed, skipped as a workaround or run on the unsuitable local Docker host. No commit, push or Phase 17 work occurred. Stop after Phase 16.6.
