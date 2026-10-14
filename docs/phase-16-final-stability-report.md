# Phase 16.5 — Search verification and infrastructure stability

**Status: INCOMPLETE. Phase 16 cannot be marked fully verified.**

## Starting repository state and audit

Continued the existing dirty repository without reset, checkout, commit or push. Starting Git status and SHA-256 hashes of 354 tracked/untracked files plus actual ignored environment files are retained in `/private/tmp/commerce-v2-phase16-5/`. No staged changes were present; existing unstaged/untracked work remains preserved. Reviewed the five historical Phase 16 reports and retained Phase 16.4 evidence, which is available. Historical reports/evidence were not overwritten.

Inspected the integration runner, current Search setup/reset/cleanup, cleanup stack, exact owned-index ledger, raw RabbitMQ scenario fixture, bounded Messaging shutdown, production-query functional preflight and disposable Compose definitions. The old `integration-diagnostics.mjs` reads workspace env files; it was inspected but not executed. All new state-changing operations used the generated owned test environment.

Host Node remains **22.23.3**, npm **10.9.9**. Verification used the existing native **Node 24.21.0** binary at `/private/tmp/commerce-v2-stabilization/node-v24.21.0-darwin-arm64/bin/node`. No silent Node 22 verification or host runtime replacement.

Actual Vitest file discovery found **34 test files**, using `vitest list --filesOnly --json`. Focused runtime discovery/execution found **13 cases: 13 passed, zero failed/skipped/unexecuted**, four files. Full dynamic case collection and complete-suite counts were not obtained because infrastructure readiness did not complete. Historical whole-suite counts are not substituted.

## Existing Phase 16.4 findings

Phase 16.4 host/container Messaging passed 75/75, including real broker and controlled lifecycle/fixture cases; these remain historical results. Container worker scheduling starvation was established by about 114 seconds runnable CPU wait. Diagnostic writes did not account for the large gaps. Memory/VM pressure was suspected but not proved the cause.

The final Search cleanup changes restore refresh settings after failure, attempt every registered cleanup, restore mocks and retain errors. The exact ledger drains writers and removes only admitted indexes; raw broker scenarios own independent connections/namespaces and retain cleanup failures. Source inspection and focused tests support these corrections. Their complete Search integration verification remains outstanding: earlier targeted Search passed four/failed three, and the latest recheck failed before discovery.

## Static Gate A and focused cleanup coverage

PASS: Node 24 typecheck; runner/setup-probe/startup-observer script syntax; whitespace; main optional Search Compose config, disposable integration Compose config and disposable Search Compose config. Production profile was validated read-only and not started. Final changes are confined to test verification infrastructure and this report.

Focused cases: two Search cleanup-stack cases, two exact owned-index cases, two raw broker fixture cases and seven Messaging shutdown cases. All **13/13 passed** under Node 24. This verifies controlled cleanup/error retention/ownership and lifecycle behavior, not real Search integration setup/teardown or the complete Messaging suite.

## Resource environment observations

Read-only host measurements before the session:

- Physical RAM: 16 GiB.
- Swap: 10,461.44 MiB used of 11,264 MiB.
- `memory_pressure -Q`: system-wide free percentage 33%; this is not a claim that all memory was exhausted.
- Compressed-memory occupancy: 504,118 pages at 16 KiB, approximately 7.69 GiB.
- Host load averages: 7.40 / 8.66 / 11.85.
- Docker Desktop: ten CPUs, 8,319,504,384 bytes memory (about 7.75 GiB), native aarch64.
- Docker stats observed 34 unrelated containers and 7,123 reported PIDs/threads. Container CPU/memory/I/O/PID snapshots are retained; high cumulative block-I/O counters are not interpreted as current I/O rates or blame assigned to a workload.

No unrelated workload was terminated or reconfigured. No global Docker/power setting changed. Existing ES test configuration remains two CPUs, 768 MiB container limit and 256 MiB fixed JVM heap with reduced tiered JIT. This phase did not tune those limits.

## One owned infrastructure startup attempt

Actual project: `commerce-v2-stabilization-07b3925e8f3f`. One disposable full-store session, random loopback ports, fresh tmpfs stores, generated service credentials and explicit owned names. Pre-existing test-only administrator credentials remain the established isolated definitions; development credentials/endpoints/volumes were not used. Test containers receive no Docker socket. No second full-store environment launched.

`docker compose up -d --wait postgres rabbitmq redis search-postgres` **succeeded in 21,143 ms**, within the unchanged 120-second Docker command budget. RabbitMQ started at **13:44:39.727 UTC (19:14:39.727 IST)**; PostgreSQL at **13:44:35.994 UTC**. ES container startup command then succeeded in 2,524 ms. Container creation timestamps and the complete initial health progression were not recovered.

Authenticated AMQP connection to the exact fresh `commerce_test` vhost passed in **334 ms**. A functional broker check used an exact project-owned quorum queue, publisher confirms, real consumer delivery/manual ACK and exact queue deletion/channel/connection cleanup; it passed in **3,701 ms**. Management provisioning and isolated PG administrator identity/database checks passed. Legacy test roles/databases were created only in the owned cluster. Redis passed its Compose PING health check. Search schema/migration/host Redis namespace checks were pending the later setup probe.

The historical 120-second RabbitMQ startup failure was **not reproduced**. The current success does not determine its earlier cause.

## Subsequent responsiveness failures

Approved read-only inspection showed both broker and PostgreSQL still labelled healthy, yet their checks had substantial elapsed delays:

- RabbitMQ check 13:47:27.406–13:47:37.275 UTC: **9.87 seconds**, timeout exit -1.
- RabbitMQ successful check 13:47:39.341–13:47:47.147: **7.81 seconds**.
- RabbitMQ check 13:47:57.427–13:48:11.560: **14.13 seconds**, timeout exit -1.
- RabbitMQ check 13:48:13.869–13:48:26.213: **12.34 seconds**, timeout exit -1; health label still healthy, failing streak two.
- PostgreSQL successful check 13:47:11.536–13:47:23.279: **11.74 seconds**.
- PostgreSQL check 13:47:39.356–13:47:49.103: **9.75 seconds**, timeout exit -1 despite output saying it was accepting connections.

Both configured health timeouts remain **five seconds**. Start/end intervals include Docker execution/scheduling/reporting behavior; they do not isolate time spent in the health command itself. Successful application responses alongside late/expired checks distinguish this from proof of an unavailable broker or an incorrect health-check command.

Two later selective Docker inspect reads exceeded their bounded five-second client deadlines (**5,011/5,016 ms**); a bounded logs read also expired (**5,031 ms**). Kernel PSI/thread scheduler snapshots, live Erlang run queue and memory alarms could not be recovered because these reads did not complete. No restart/OOM/CPU-starvation cause is inferred from missing data. The first startup observer initially exceeded its 24-KiB full-inspect response cap; corrected to select only needed state/ownership/port fields. Later bounded read failures were genuine timeouts, not buffer-cap failures.

The parent remained responsive: maximum five-second sample gap **5,003 ms**, maximum observed parent event-loop delay **64.72 ms**. This does not show a host-wide sleep interval during the new session. Historical clamshell sleep remains separate. Temporary caffeinate ended with the command; no permanent power change or guarantee against lid closure.

Classification: current broker started and became application-ready; later health/management execution/reporting responsiveness was unsuitable. Categories E/F/G are investigation possibilities, with Docker/health timing delay directly observed; exact guest scheduling/IO/health-execution contributions remain unknown. The historical startup timeout remains category H (unknown), rather than being labelled a RabbitMQ defect.

## Controlled stop at infrastructure Gate B

Following the user's instruction to stop additional heavy verification on an unsuitable environment, interrupted only the ownership-checked Node runner PID 38643. The runner stopped during cold Elasticsearch readiness at **13:50:56 UTC (19:20:56 IST)** and executed scoped cleanup. This is a controlled stop for measured responsiveness, not approval denial, host sleep, test assertion failure, suite setup failure or teardown timeout.

Elasticsearch was still loading modules; HTTP/functional mapping/index/refresh/alias/full-text/cleanup preflight did not complete. Its existing 900-second cold budget was not increased or exhausted. No new ES operation latencies or Search PG acquisition/query/lock measurements are claimed. The previous warm-query and post-TCP protocol latency observations remain historical evidence, not new results. Parent diagnostic PG query sampling had not started: zero probes means **unexecuted**, not evidence of zero latency/failures.

Infrastructure Gate B is **INCOMPLETE**. No further heavy runs were launched.

## Verification gates and counts

- Gate A static: PASS.
- Gate B complete responsive infrastructure: INCOMPLETE; store startup/AMQP/management provisioning passed, later Docker/health responsiveness failed to stay suitable, ES functional readiness unexecuted.
- Gate C complete Messaging host: UNEXECUTED. Complete Messaging container: UNEXECUTED. Nine controlled Messaging cases passed within the focused 13-case set; they are not a full-suite result.
- Gate D seven targeted Search scenarios: UNEXECUTED; selected/excluded counts not available because selection did not run. No business assertion or expected authorization error changed.
- Gate E complete Search Run 1: UNEXECUTED.
- Gate F complete Search Run 2: UNEXECUTED.
- Gate G full regression Run 1: UNEXECUTED.
- Gate H full regression Run 2: UNEXECUTED.

No integration body or integration teardown hook ran. No skipped/unexecuted test is counted as passing. Existing full-suite gates were not bypassed.

## Exact changes and files

Modified `scripts/integration-runner.mjs`:

- Opt-in bounded startup observation around the existing store startup command, retaining the original deadline.
- Functional AMQP confirmation/delivery/ACK/readiness and exact owned queue cleanup, retaining primary/cleanup errors and a bounded close/transport-loss path.
- Opt-in `INTEGRATION_STABILITY_STAGES=true`: readiness/schema/latency probe before Messaging, host and container Messaging in the same owned project, then targeted Search and both unfiltered Search/regression stages, stopping on the first failure.
- Generated temporary port settings switch between host loopback mappings and container namespace ports; mode-specific report handling, one private image build and exact image/container cleanup. Default application/feature opt-ins and existing recovery-stage ordering are unchanged.

Added `scripts/integration-startup-observer.mjs`: project-label validation; capped selective state/health/kernel/resource/management/AMQP observations and boot-log evidence. One initial read cap mistake was corrected; original failed evidence retained. No business-module, migration, Search assertion, Messaging lifecycle or Compose limit changed.

The successful AMQP readiness flow ran before final callback guards were added to reject cancellation, unexpected payload and connection loss rather than leaving delivery pending. Those final guards and the reduced observer format have static checks; a full runtime rerun was deliberately not launched on the unsuitable environment. Dual-mode stage switching also remains unexecuted because Gate B did not complete. These harness limitations are not presented as verified application results.

Added this report. No new application features, frontend, dependency changes, old-project edits or Phase 17.

## Cleanup, preservation and approval

Scoped `docker compose down --volumes --remove-orphans` succeeded in **33,118 ms**, finishing **13:51:45 UTC (19:21:45 IST)**. Final read-only inventory confirmed **zero owned containers, networks, volumes and private image tags**. No Node test image was built before the stop. Temporary generated env/output directory removed; evidence intentionally retained.

Final SHA-256 comparison: only the intended existing integration runner changed; no starting file missing, actual env/example files and historical reports unchanged. New files are the startup observer and this report. Development state was preserved by restricting all mutations to this project and generated endpoints; no development data export/comparison was performed. Staged/unstaged/untracked work and optional feature defaults preserved.

All requested execution/read/interrupt/inventory approvals were granted. No denied or currently blocked command; no bypass. No global prune, shared image deletion, daemon restart, unrelated stop, commit or push.

## Evidence and reproduction

Evidence root: `/private/tmp/commerce-v2-phase16-5/`: starting status/checksums; resource baseline; actual discovered-files JSON; 13-case focused report; bounded session JSONL; initial boot logs/observer errors; selective health timestamp transcription from the approved inspect result; failed recovered observer read JSON; final resource inventory and preservation audit.

Attempted session command used native Node 24.21.0 with `caffeinate -i -s`, `INTEGRATION_EXECUTION=host`, `INTEGRATION_STARTUP_AUDIT=true`, `INTEGRATION_RECOVERY_STAGES=true`, `INTEGRATION_LATENCY_STAGES=true`, `INTEGRATION_STABILITY_STAGES=true`, report directory `<evidence>/stability-session` and diagnostics `<evidence>/stability-session.jsonl`, running `scripts/integration-runner.mjs`. Only one project was created.

## Confirmed findings, hypotheses and decision

Confirmed new finding: store startup succeeded, but current owned-container health execution/reporting and bounded Docker reads had multi-second delays inconsistent with reliable verification of unchanged short application budgets. Confirmed instrumentation issue: full inspect exceeded its response cap and was narrowed. No new application correctness defect was established or speculative application fix applied. Historical worker runnable wait and fixture defects remain the separate previously confirmed findings.

Unproven: host/VM paging or competing workloads causing these delays; current Erlang CPU starvation, memory alarms, Docker scheduling versus health-execution delay; exact cause of the historical broker startup timeout; authentication/pool/authorization defect; ES server/GC/allocation versus underlying IO scheduling. High swap/PID counts alone do not prove causation.

Use a dedicated, adequately resourced Node 24 runner with verified responsive Docker/dependency operations and a stable awake interval, then run the unchanged gated sequence. Do not accommodate an overloaded substrate by weakening assertions or production budgets. No specific unrelated workload should be blamed or terminated from this evidence.

**Final decision: Phase 16.5 INCOMPLETE. Phase 16 cannot be marked fully verified.** Responsive complete infrastructure, current complete Messaging, final targeted Search, two complete Search passes and two complete regression passes remain required.
