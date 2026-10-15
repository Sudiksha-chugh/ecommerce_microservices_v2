# Phase 16.4 — Container worker and dependency latency

**Status: INCOMPLETE. Phase 16 is not fully verified.**

## Starting state and evidence

Continued from the dirty working tree without reset or checkout. Recorded SHA-256 hashes of existing tracked, untracked and actual env files plus git status in `/private/tmp/commerce-v2-phase16-4/`. Installed Node remains 22.23.3/npm 10.9.9; verification uses the retained native Node 24.21.0 binary. Read all four historical Phase 16 reports; retained Phase 16.3 evidence exists. Previous reports remain unchanged.

Node 24 typecheck, runner syntax, whitespace, disposable Compose and main optional Search Compose validation passed initially. No full regression launched.

## Existing failure matrix

The complete 27-entry machine-readable matrix (including the intermediate failed regression) is retained at `/private/tmp/commerce-v2-phase16-4/existing-failure-matrix.json`. Categories: A connection acquisition; B query execution; C ES deadline; D functional readiness; E RabbitMQ; F worker stall; G fixture hook/cleanup; H sleep; I assertion; J unknown. Stack frames and elapsed durations are retained. Unknown worker identities/underlying operations are explicit, rather than reconstructed from sanitized exceptions.

- **I/J** — Real RabbitMQ durability and routing detects mandatory unroutable messages even when the broker confirms receipt; 28254.55 ms; container, pid 44; body executed. Error: expected error to be instance of UnroutableMessageError.
- **E/F** — Connection, channel and handoff recovery recovers a broker-link interruption without duplicate active consumers; 130104.16 ms; container, pid 44; body executed. Error: Test timed out in 30000ms..
- **E/G/G** — Connection, channel and handoff recovery does not ACK when retry handoff is unroutable; 17.71 ms; container, pid 44; body unexecuted (hook failure). IllegalOperationError: Connection closed (Error: write ECONNRESET).
- **E/G/G** — Connection, channel and handoff recovery does not ACK when dead handoff is unroutable; 30.59 ms; container, pid 44; body unexecuted (hook failure). IllegalOperationError: Connection closed (Error: write ECONNRESET).
- **E/G/G** — Connection, channel and handoff recovery fails an interrupted in-flight publication and recovers without a stale publisher; 1.04 ms; container, pid 44; body unexecuted (hook failure). IllegalOperationError: Connection closed (Error: write ECONNRESET).
- **E/G/G** — Connection, channel and handoff recovery recovers from consumer cancellation and re-registers exactly once; 1.06 ms; container, pid 44; body unexecuted (hook failure). IllegalOperationError: Connection closed (Error: write ECONNRESET).
- **E/G/G** — Connection, channel and handoff recovery bounds shutdown with a blocked cancellation reply and preserves unacknowledged work; 0.58 ms; container, pid 44; body unexecuted (hook failure). IllegalOperationError: Connection closed (Error: write ECONNRESET).
- **E/G/G** — Connection, channel and handoff recovery returns an unacknowledged delivery after shutdown deadline and does not ACK on stale channels; 0.78 ms; container, pid 44; body unexecuted (hook failure). IllegalOperationError: Connection closed (Error: write ECONNRESET).
- **E/G/G** — Connection, channel and handoff recovery recovers after a real consumer process crashes before ACK; 1.30 ms; container, pid 44; body unexecuted (hook failure). IllegalOperationError: Connection closed (Error: write ECONNRESET).
- **C/G** — isolated multi-service Search integration fixture cleanup regression removes unrefreshed writes and preserves a different owned fixture prefix; 4347.01 ms; host, pid 52767; body unexecuted (hook failure). beforeEach refresh/delete-by-query.
- **C** — isolated multi-service Search integration fixture cleanup regression waits for an in-flight consumer write before taking the deletion snapshot; 11541.05 ms; host, pid 52767; body executed. Error: Search temporarily unavailable.
- **J** — isolated multi-service Search integration fixture cleanup regression can repeat an interrupted deletion without leaving stale data for rollback audits; 19446.25 ms; host, pid 52767; body executed. Error: Isolated search readiness/assertion deadline exceeded.
- **A** — isolated multi-service Search integration Catalog transactional source and version contracts Search cannot connect to the private Catalog database; 7925.46 ms; host, pid 52767; body executed. forbidden Pool.query connection acquisition (existing 1000ms test budget).
- **A** — isolated multi-service Search integration projection, duplicate and stale-event protection concurrent consumers cannot roll back a newer version; 3778.51 ms; host, pid 52767; body executed. SearchRepository.receive -> pool.connect.
- **C** — isolated multi-service Search integration projection, duplicate and stale-event protection replaying an old event after loss of a physical index does not auto-create a dynamic index; 5331.99 ms; host, pid 52767; body executed. Error: Search temporarily unavailable.
- **C/G** — isolated multi-service Search integration projection, duplicate and stale-event protection inbox commit failure after Elasticsearch success is recoverable; 2944.66 ms; host, pid 52767; body unexecuted (hook failure). beforeEach GET mapping.

Search file: `apps/search-service/test/integration.test.ts`, host worker 52767. Setup and final teardown succeeded. Container file: `packages/messaging/test/rabbitmq.test.ts`, worker 44. Mandatory-return assertion and reconnect body failed first; seven following bodies were blocked by raw connection closure. AfterEach purges and afterAll channel creation also failed. The first wrong error type does not establish a return-handling bug.

## Investigation plan and boundaries

Compare the identical 73 Messaging tests sequentially in host/container modes, with minimal/existing diagnostics. Minimal retains runtime and ten-second worker scheduling samples, and omits per-test diagnostic writes. Timing instrumentation measures actual synchronous append durations before any diagnostic implementation correction. Same Node 24.21.0, RabbitMQ 4.2 image, generated isolated configuration, maxWorkers=1, assertions and deadlines. One owned project at a time. Keep existing complete-store startup for equivalence.

PostgreSQL acquisition evidence does not prove exhaustion: total=10, idle=2, waiting=0. Service pools retain two-second acquisition deadlines; the separate authorization-negative pool uses its existing one-second deadline. Query timeout, lock and transport latency remain separate questions. No query/development setting changed. Exact ES ledger validates owned generation names and drains writers before exact deletions; no wildcard cleanup.

Historical full-regression clamshell sleep correlated with roughly 249-second parent/worker gaps. Container Messaging stalls occurred while parent gap stayed approximately one second, so they are not attributed to that sleep. Temporary caffeinate supports the current awake interval without permanent power changes. Keep the Mac awake and lid open during verification.

## Initial gated verification state

Messaging comparison/host/container: running. Targeted Search, Search Run 1/2, full regression Run 1/2: unexecuted pending earlier gates. No skipped or unexecuted case is reported as passing.

## Safety

No development stores, existing volumes, actual env files or optional defaults changed. No unrelated containers stopped; no global prune/daemon restart. No commit, push, frontend, old-project modification or Phase 17. Scoped disposal will be recorded per project. No approval rejected so far.

## Controlled host/container comparison

All four broker comparisons used fresh sequential disposable projects, Node 24.21.0, RabbitMQ 4.2-management, the same 73 tests/assertions/deadlines, serial test-file concurrency and the same PostgreSQL/RabbitMQ Compose services. Host used mapped loopback ports; container used the shared store namespace and image filesystem. Minimal diagnostics retained runtime and ten-second scheduling samples, omitting per-test writes. Existing diagnostics retained all earlier test timing writes, with added write-cost counters. These are single trials, not statistical estimates.

- Initial full-store attempt `66894bb36073`: no tests discovered. ES cluster health took 460.56 seconds. Functional full-text readiness eventually succeeded after repeated two-second request timeouts, but exact probe-index DELETE timed out, failing preflight. The project cleaned successfully. This is separate from the broker comparisons.
- A host minimal (`2e83ce05871a`): 73/73 passed, 30.47 seconds; maximum observed diagnostic append 0.63 ms; periodic worker gap approximately ten seconds. Parent PG probes 31/31, maximum 36.35 ms, timer gap 1,004.63 ms.
- B host existing (`bfe112a94b31`): 73/73 passed, 26.64 seconds; maximum append 0.82 ms. Parent probes 27/27, maximum 14.73 ms, gap 1,002.77 ms.
- C container minimal (`23c0a38a5e25`): 71 passed/two failed/zero pending, 169.53 seconds. Negative-confirm test timed out during a 144,771-ms worker sample gap (142,942-ms event-loop delay); the subsequent reconnect assertion received seven calls instead of two. All later bodies executed. Maximum diagnostic append 22.85 ms; the sole write preceding the long gap took 3.44 ms. Parent probes 171/171, maximum 846.09 ms, gap 1,015.83 ms.
- D container existing (`7e30b50462d5`): 73/73 passed, 272.99 seconds, despite a 179,345-ms worker gap. Maximum append 65.84 ms. CLI attributed 69% of duration to import and 19% to transform, versus 11% tests. Parent probes 274/274, maximum 645.14 ms, gap 1,006.88 ms.

All four had actual Node 24 worker records. All projects reported scoped cleanup, including private container image disposal. Container mode being green in one comparison does not negate its failed comparison or establish stable dependency latency.

## Confirmed scheduling and diagnostic findings

An approved read-only snapshot inside C's exact runner container showed main-thread scheduler counters: 18.93 seconds running, 114.38 seconds waiting runnable for CPU, 9,154 timeslices; 4,910 major faults, about 9.86 GB kernel read_bytes, 59 MB RSS, zero guest process swap and 11 threads. Instantaneous wchan was futex_do_wait. These are cumulative process counters; the instantaneous wait channel does not explain an entire interval. The long runnable wait directly establishes scheduling starvation in that worker. Parent scheduling remained regular; host-wide sleep does not explain this instance.

The write immediately preceding the reproduced minimal-mode gap was 3.44 ms, not 145 seconds. Existing-mode writes were at most 65.84 ms during a 179-second gap. Diagnostic synchronous append overhead is measured and is not established as the cause of these large stalls. No all-diagnostics disablement or unsupported asynchronous logging rewrite was applied. Existing logs are bounded at 1,000 worker / 2,000 stage / 2,000 parent rows; fixture's older supplemental sink has no shared cap and remains a potential overhead concern outside the Messaging comparison. Parent five-second probes and container-start inspection remain bounded; per-query Search stage writes are outside these Messaging trials.

Host read-only observations: 9,615.44 MB swap in use, 509,767 compressed pages at 16 KB (approximately 8.35 GB). Paging, Docker Desktop VM scheduling, competing workloads and filesystem/import demand remain possible sources of the scheduling pressure. No specific workload, daemon setting or RabbitMQ defect is proved responsible. Production request budgets and test deadlines remain unchanged.

## RabbitMQ correctness and fixture correction

Mandatory returns are matched by publication-id before confirm resolution; pending confirms reject on timeout/session loss. Messaging sets a five-second heartbeat; the raw fixture uses amqplib's default. Seven controlled shutdown tests remain green. Minimal-mode mandatory-return case passed, so the earlier wrong exception does not establish a permanent classification defect.

Confirmed fixture defect: the original beforeAll raw connection was reused in beforeEach after ECONNRESET, preventing seven later bodies from entering. It also shared one namespace throughout the file, exposing later cases to late publications after timeout; C's seven-call assertion is consistent with this contamination, but individual extra publication identities were not recorded, so that causal explanation is not claimed proved.

Correction: `raw-scenario.ts` allocates an independent connection, confirm channel and random owned namespace per case. Teardown stops scenario consumers/children/proxies, deletes only that scenario's exact queues/exchanges, closes channel then connection. If cleanup transport fails, a fresh connection retries exact owned cleanup and the original failure is retained in AggregateError. Later scenarios never reuse a closed connection or queue namespace. Setup-failure cleanup is registered before topology declaration. Repeated close shares its completion promise. Two controlled regressions cover independent ownership/serial closure, and closed-transport recovery that preserves the original error and allows a fresh later scenario. Combined fixture/lifecycle regressions passed 9/9; Node 24 typecheck passed.

## Files changed so far

- `scripts/integration-runner.mjs`: explicitly opt-in complete-Messaging-only environment, guarded against filtering/other selectors; minimal-diagnostics flag propagated into container; container lifecycle timestamps retained. Normal Search/full-regression defaults remain unchanged.
- `test/integration-timing.ts`: measured synchronous diagnostic write costs; opt-in minimal mode retains worker runtime and periodic scheduling samples.
- `packages/messaging/test/rabbitmq.test.ts`: scenario-owned raw connections/namespaces and exact teardown, unchanged business assertions.
- New `packages/messaging/test/raw-scenario.ts` and `raw-scenario.test.ts`, plus this report.

Final-source host/container Messaging verification is pending. Targeted Search and both complete Search/regression runs remain gated. No diagnostic change is claimed to solve scheduling starvation.

## Final-source Messaging verification

Host `6313f7d9ab04`: **75/75 passed**, five files, 141.54 seconds; all 22 real-broker cases, seven lifecycle cases, 40 contract cases, four readiness cases and two raw-fixture regressions executed. Setup/teardown passed, zero skips/unexecuted cases. Maximum periodic worker gap 10,002 ms (ten-second sampler), diagnostic append 1.21 ms. Parent 141 PG probes, zero errors, max 634.09 ms, one-second gap 1,008.26 ms.

Container `ab754750be3b`: **75/75 passed**, five files, 38.58 seconds. Same final assertions; runtime v24.21.0, zero skips/unexecuted cases, setup/teardown passed. Max periodic worker gap 10,013 ms, diagnostic append 9.20 ms. Parent 66 PG probes, zero errors, max 337.42 ms, gap 1,004.36 ms. Exact runner-start wall timestamps are now recorded. Both projects cleaned successfully, including container private image.

Per-case quorum creation/deletion increased host fixture cost in this run; no queue durability or failure assertions were weakened. A clean final run under responsive scheduling does not prove the external scheduling starvation is permanently corrected.

## Search investigation execution

A separate gated full-store project `f27538ac0bce` is now running. Messaging re-executes under the heavier Search environment to detect load-dependent substrate failures. Opt-in latency stages measure numeric-loopback TCP completion versus PostgreSQL connection/auth completion, fresh sequential/concurrent clients versus reused pool acquisition, and SELECT 1 execution separately. Existing two-second connection and five-second statement budgets remain. Three sequential and five concurrent connections for each owned Catalog/Search DB; three sequential and three concurrent warm ES full-text queries. All failures stay failed. No development endpoint or arbitrary idle wait is used. Cold ES mapping/write/refresh/alias/search/cleanup durations are retained by existing preflight instrumentation.

After setup/latency and the representative single-query probe, seven previously failed Search cases run with an explicit targeted selector. Only this targeted stage is filtered; both required whole Search stages and both full regressions use unchanged complete discovery. Each JSON output is independent. The runner stops on the first failed stage.

Additional changed file: `scripts/search-setup-probe.mjs` adds the explicitly selected latency measurement mode, preserving the original setup/single modes. `INTEGRATION_LATENCY_STAGES=true` is gated and opt-in; default recovery behavior remains unchanged.

## Search latency findings and first targeted gate

Full-store Messaging passed 75/75 in 223.36 seconds. Latency/setup probe passed assertions and cleanup; representative single Search passed HTTP 200 and cleanup. Own cold cluster health took 421.60 seconds and functional preflight 12.30 seconds, with successful exact probe deletion.

Catalog numeric-loopback TCP events: 0.42–0.91 ms; completed connection/auth: 460.33–1,722.59 ms; SELECT 1: 3.55–99.44 ms; pool acquisition: 0.38–311.09 ms. Search TCP: 0.26–0.81 ms; completed connection/auth: 91.34–396.18 ms; SELECT 1: 1.86–199.31 ms; pool acquisition: 0.31–755.13 ms. Each database had eight fresh clients and eight pooled acquisitions, with sixteen queries. Warm ES full-text sequential durations: 914.71/626.72/813.02 ms; concurrent: 59.35/231.07/322.42 ms. All operations passed their unchanged budgets. This small trial does not show concurrency necessarily being slower, and does not reproduce all intermittent failures.

Local TCP acceptance was fast while completed PostgreSQL protocol/auth took much longer. Host loopback port forwarding can accept TCP before backend processing; these observations do not isolate password authentication from forwarding, server scheduling or transport responsiveness. Numeric endpoints exclude DNS for this probe. No query/lock/permission defect or pool exhaustion is proved. Existing idle eviction stays unchanged; no artificial eviction wait or development PostgreSQL tuning.

Targeted Search `T-search-targeted.json`: **four passed, three failed, 73 excluded by explicit selector**, 101.98 seconds. All seven selected bodies executed; setup passed. Worker 24886. Failures:

- `removes unrefreshed writes and preserves a different owned fixture prefix`: body DELETE-by-query at cleanup.ts:9 hit ELASTICSEARCH_TIMEOUT, approximately 2,005 ms; case 9,952 ms. Explicit pre-refresh completed. Category C (request deadline), rather than a count assertion or ownership rejection.
- `can repeat an interrupted deletion without leaving stale data for rollback audits`: later production rebuild PREPARING index creation hit ELASTICSEARCH_TIMEOUT at 2,003 ms; rebuild phase deadline failed after 11,010 ms; case 20,406 ms. Category C/D. Existing durable retry/backoff remained intact; no deadline enlarged.
- `Search cannot connect to the private Catalog database`: connection timeout before expected permission-denial message; case 3,345 ms. Category A. The exact denial assertion remains unchanged; this is not proof of an authorization defect.

The in-flight consumer cleanup, concurrent version protection, missing physical index protection and inbox recovery selected cases passed. Intended failure injection also produced a document transport error and recovered; that is not classified as a new failed application assertion. Final exact index teardown passed in 661.73 ms, total teardown 894.08 ms. No PG_ACQUIRE failures were logged in the selected run; the forbidden test's independent pool is outside that wrapper. Parent 385 successful PG probes, zero errors, max query 1,961.29 ms, max one-second gap 1,005.69 ms. No comparable host sleep gap. The pipeline stopped before both whole Search/full-regression stages and cleaned its project.

## Additional confirmed Search fixture corrections

Code review of the reproduced failed first cleanup case found that `refresh_interval=-1` restoration existed only after all assertions, so a deadline failure could leave fixture settings changed for following cases. Its restoration is now registered before the mutating request, including ambiguous successful requests. The previous afterEach loop aborted on its first cleanup error, preventing remaining cleanup actions and mock restoration. New `closeScenario` attempts each exact owned cleanup in reverse order, always attempts mock restoration, and reports every error in AggregateError. Nothing is silently converted into success.

Added `apps/search-service/test/cleanup-stack.ts` and `.test.ts`; modified `apps/search-service/test/integration.test.ts`. Two controlled regressions prove refresh-setting/mock restoration after another cleanup failure, retention of all errors and safe repeated cleanup. Combined cleanup-stack/owned-index regressions passed 4/4; Node 24 typecheck and whitespace passed. Business assertions, source capture, versions/tombstones, alias/rebuild safety, two-second ES/PG service budgets and global/hook deadlines remain unchanged.

The final targeted recheck used the same seven selectors in a fresh project and reused the completed Messaging/latency verification because those sources are unchanged. It failed before test discovery, as recorded below. No unsupported latency fix or permanent power/daemon change was applied.

## Final targeted recheck and verification decision

Project `84bdb3300ca2` failed **before test discovery**: `docker compose up -d --wait postgres rabbitmq redis search-postgres` exceeded its unchanged 120-second Docker command deadline (120,132 ms). PostgreSQL, Search PostgreSQL and Redis were healthy; RabbitMQ readiness remained pending. No Elasticsearch launch, Search setup or selected test body executed. Root of the startup latency is unproven; the deadline was not increased. Scoped cleanup succeeded in 15.89 seconds. No Vitest result JSON was created; the distinct startup status is retained in `search-targeted-recheck-status.json`.

The final Search fixture corrections have controlled coverage and static verification, but **not a completed integration rerun**. The prior four-pass/three-fail targeted result precedes these corrections. No repeated identical heavy retry or unsupported substrate change was performed after the fresh startup failure.

- Static Stage A: PASS under Node 24.21.0. Final typecheck, both changed script syntax checks, main optional Search/disposable regression/disposable Search Compose config and whitespace passed.
- Messaging host: PASS, 75/75 on final Messaging source; all discovered bodies and hooks passed, zero skips/unexecuted cases. Full-store repeat also passed 75/75.
- Messaging container: PASS, 75/75 on final Messaging source; all discovered bodies/hooks passed, zero skips/unexecuted cases. Earlier baseline comparison failures remain recorded.
- Targeted Search: prior gate FAILED, four passed/three failed/seventy-three deliberately excluded by selector; final correction recheck UNEXECUTED due startup failure.
- Complete Search Run 1: UNEXECUTED.
- Complete Search Run 2: UNEXECUTED.
- Full regression Run 1: UNEXECUTED.
- Full regression Run 2: UNEXECUTED.

The required gates prevent later complete suites from running after targeted failure. No selected/skipped/hook-blocked case or historical pass is substituted for final complete-suite verification. **Phase 16.4 is INCOMPLETE; Phase 16 cannot be marked fully verified.**

## Confirmed causes versus remaining hypotheses

Confirmed: localized container worker scheduling starvation (114 seconds runnable CPU wait), with large event-loop gaps under minimal and existing diagnostics; reuse of a closed raw broker fixture connection blocked subsequent hooks; Search's failure-path refresh setting restoration was absent and cleanup stopped at its first error. Fixture corrections preserve original errors, exact ownership and business assertions. The underlying scheduler/host pressure has not been corrected or claimed permanently resolved.

Confirmed latency classification: connection completion can be slow after immediate local TCP acceptance; warm ES requests can pass, while later index creation/delete-by-query exceed the unchanged two-second budget. These identify failing phases, not an application authentication/rebuild defect. Main parent query responsiveness does not prove the separate Search cluster is uniformly responsive. No pool exhaustion, connection leak, authorization defect, mandatory-return protocol defect or universal ES readiness failure is established.

Unproven: Docker Desktop VM/host memory and paging pressure as the source of scheduling starvation; which workload or resource limit caused it; forwarding versus backend process/authentication contributions to PostgreSQL latency; ES allocation/refresh/metadata scheduling versus GC/caching causes; exact origin of the final RabbitMQ cold startup delay. Synchronous diagnostic writes were not large enough to account for the reproduced worker gaps. Extra reconnect calls are consistent with late-publication contamination, but individual extra event identities were not captured. Earlier clamshell sleep remains a separately confirmed historical interruption, not the cause assigned to these regular-parent runs.

## Final files, preservation and resource cleanup

Existing files changed in Phase 16.4:

- `packages/messaging/test/rabbitmq.test.ts`.
- `apps/search-service/test/integration.test.ts`.
- `scripts/integration-runner.mjs`.
- `scripts/search-setup-probe.mjs`.
- `test/integration-timing.ts`.

New repository files: `packages/messaging/test/raw-scenario.ts`, `raw-scenario.test.ts`; `apps/search-service/test/cleanup-stack.ts`, `cleanup-stack.test.ts`; this report. No application production module, migration, dependency manifest or feature default changed. No assertions or failure injection disabled, no global/hook/request deadline increased, no arbitrary success-inference sleep introduced.

Final checksum audit compared every starting tracked/untracked file plus actual ignored env files. No missing files; only the five intended existing files changed. Actual environment files and all historical Phase 16 reports match starting hashes. Existing development data was preserved by restricting mutations to owned generated endpoints/namespaces; no development data export/comparison was attempted.

All nine actual projects reported scoped disposal. A final approved read-only inventory confirmed zero remaining owned containers, networks, volumes and private test-runner image tags. The pre-existing `commerce-v2-rate-limit-test-ef695590` container remains present. No unrelated resources stopped or pruned. All runner/temporary caffeinate commands ended; evidence remains intentionally retained. No global daemon restart or permanent power change.

No execution approval was rejected. One read-only swap query was sandbox-blocked, then explicitly escalated and approved; no currently blocked command and no bypass. Actual startup/test failures are distinct from approval restrictions. No commit, push, old-project edit, frontend or Phase 17.

## Reproduction and evidence

All new evidence: `/private/tmp/commerce-v2-phase16-4/`. Includes starting/final checksums/status, existing/new failure matrices, A–D independent JSON results and diagnostics, final host/container Messaging reports, actual worker runtime/write timing samples, owned-worker `/proc` snapshot, cleanup/lifecycle regression results, `search-gated` independent stage JSON reports, failed recheck diagnostics/status and final resource inventory.

All commands use `/private/tmp/commerce-v2-stabilization/node-v24.21.0-darwin-arm64/bin/node`, wrapped in `caffeinate -i -s` for integration runs. Normal runner invocation uses `scripts/integration-runner.mjs`, always a unique owned project.

Controlled comparisons: `INTEGRATION_MESSAGING_ONLY=true INTEGRATION_EXECUTION=host|container INTEGRATION_DIAGNOSTICS_MODE=minimal|existing INTEGRATION_DIAGNOSTICS_FILE=<evidence>.jsonl node scripts/integration-runner.mjs packages/messaging/test --reporter=default --reporter=json --outputFile=<report>.json`. Final host/container runs use the same command with existing diagnostics and final source.

Gated Search command: `INTEGRATION_EXECUTION=host INTEGRATION_RECOVERY_STAGES=true INTEGRATION_LATENCY_STAGES=true INTEGRATION_REPORT_DIR=<evidence>/search-gated INTEGRATION_DIAGNOSTICS_FILE=<evidence>/search-gated-diagnostics.jsonl node scripts/integration-runner.mjs`. It proceeds B Messaging → C latency/setup → D single → T targeted → E/F unfiltered Search → G/H unfiltered full regression, stopping on the first failed stage.

Final targeted command used normal host runner with `apps/search-service/test/integration.test.ts`, the exact selector `fixture cleanup regression|Search cannot connect to the private Catalog database|concurrent consumers cannot roll back a newer version|replaying an old event after loss of a physical index|inbox commit failure after Elasticsearch success`, default+JSON reporters, `search-targeted-recheck.json` output and `search-targeted-recheck.jsonl` diagnostics. The command failed before discovery; the absent Vitest report is intentional evidence of that gap.

Remaining work: responsive owned infrastructure, completed final targeted integration verification, two clean unfiltered Search runs, then two clean full regressions with zero skipped/unexecuted cases. The task's success criteria remain unmet.
