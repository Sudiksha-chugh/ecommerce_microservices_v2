# Phase 16 dedicated verification runner

The runner is prepared locally. No dedicated Linux host or authorized transfer mechanism is available, so runtime verification remains blocked. The manual workflow is a draft and has not been installed remotely or dispatched. A branch checkout alone does not contain this uncommitted working tree.

## Local preparation

Use Node 24.21.0 (also pinned in the integration Dockerfile) and the existing locked dependencies:

```sh
node scripts/verify-phase16.mjs --prepare-only
```

This runs type checking and the separate harness suite, checks Docker Compose availability and validates only the disposable integration configuration. It creates no containers. Each invocation creates a unique evidence directory; set `PHASE16_EVIDENCE_DIR` to choose its parent. Neither preparation nor runtime changes the development env files or application feature defaults.

## Source identity and transfer

Create a local source-only archive in a new absolute destination:

```sh
node scripts/verification-snapshot.mjs /absolute/local/phase16-source.tar.gz
```

The command enumerates tracked and untracked nonignored files and includes implementation, tests, migrations, workspace manifests, lockfile, TypeScript configs, Dockerfiles, test infrastructure and example env files. It excludes actual `.env*`, node_modules, Git metadata, development data directories, secret/credential files, documentation and historical result artifacts. It rejects nonregular selected files and existing archive destinations. The archive contains a SHA256 manifest covering every included source file. The identity refers to the source projection of the working tree, not its branch HEAD, docs, development data or installed dependencies. Review the archive before any future authorized transfer. This command never uploads anything.

After a Linux host and transfer mechanism are explicitly available/authorized, extract into a new dedicated directory, verify the printed identity, and install locked dependencies locally on that runner:

```sh
npm ci --ignore-scripts
PHASE16_SOURCE_IDENTITY=<printed-sha256> node scripts/verify-phase16.mjs
```

A missing, altered or mismatched source manifest fails before gates. The current CI draft likewise requires an expected source identity and manifest in its checkout. It cannot verify the current dirty tree until an authorized mechanism supplies that exact source; there is no automated dirty-tree upload or fallback to branch HEAD.

## Candidate Linux capacity

Plan for at least four Docker CPUs and roughly 16 GiB host/Docker memory with eight GiB available before execution. The entry point enforces Linux, four Docker CPUs, 14 GiB Docker memory and eight GiB `/proc/meminfo` available memory. These are conservative planning floors, not measured peak demand or proof of suitability. Two PostgreSQL instances, RabbitMQ, Redis, Elasticsearch, Node/Vitest/subprocesses, image build, filesystem cache and OS headroom all contribute. Elasticsearch already has its unchanged 768 MiB cap, 256 MiB heap and two-CPU limit. Estimate 8–12 GiB of usable envelope including reserve; actual responsiveness is decided by functional Gate B. Do not resize Docker Desktop, weaken assertions or enlarge test timeouts to satisfy a gate.

A small/private hosted runner can fail this capacity check; choose an already authorized adequately sized dedicated host instead. GitHub documents differing hosted runner resources in its [runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). No paid runner is provisioned by this task.

## Ordered runtime gates

Gate A checks types and all harness cases/hooks. The existing isolated runner owns a fresh random Compose project and generated env directory. It builds the Node 24 container, boots disposable stores and performs functional broker readiness before launching stages:

1. B: representative Search setup, concurrent store operations, responsiveness and fixture cleanup.
2. C: complete Messaging on host, then complete Messaging in the container.
3. D: seven selected Search regressions only; selector exclusions are expected for this gate.
4. E/F: complete Search suite twice, without a selector or skipped cases.
5. G/H: default full regression discovery twice, without exclusions or skipped cases.
6. I: cleanup of owned resources, attempted even after partial startup or a failed gate.

Any failure stops subsequent stages. Full-suite JSON must report success, every discovered case passed, zero failures, zero pending cases and zero failed suites; probe JSON must confirm setup/assertions/cleanup. Each stage has a separate report name. Runner/worker diagnostics are bounded JSONL. Generated credentials in retained stage JSON are redacted. Missing reports are failures, never inferred passes. There are no automatic runtime retries or timeout increases.

Cleanup verifies the exact project/service labels before deleting one-off runners, removes only the exact owned image, uses project-scoped Compose down and deletes only its generated temporary directory. No pruning or unrelated container/volume deletion occurs. Cleanup errors produce a failing exit. Abrupt machine loss/SIGKILL still requires a later ownership-scoped audit; `always()` artifact retention cannot prove cleanup after a lost runner.

## Manual CI draft

`.github/workflows/phase16-verification.yml` uses manual dispatch only, serialized execution without cancelling an active job, read-only repository permissions, Node 24.21.0, locked installation, the same entry point and `always()` JSON/JSONL artifact retention. It has no deploy/application credentials and disables persisted checkout credentials. Actions are pinned to official release commits: [checkout v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1), [setup-node v7.1.0](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1), and [upload-artifact v7.0.2](https://github.com/actions/upload-artifact/commit/cf430e030ddbb5b0abf93d22962f4752f3646cd9).

The 180-minute CI job envelope does not change application/Vitest timeouts or readiness/startup budgets. Neither the workflow nor dependency installation has been executed on Linux. Source transfer, workflow installation and dispatch require a later authorized environment; no commit or push has been performed.
