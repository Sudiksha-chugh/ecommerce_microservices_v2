# ADR 017: bounded performance diagnostics and observed dominant envelopes

Status: accepted for Phase 21 implementation; deployment readiness depends on verification.

## Context

Existing observability already supplies bounded collectors, authenticated diagnostics and optional AI transport. Distributed parent links and timestamps describe observed intervals but do not encode all scheduling dependencies. Summing inclusive or parallel child durations would misstate response-time contribution.

## Decision

Expose a reusable `@ecommerce/observability/performance` subpath on the existing opt-in loopback diagnostics host. Share Phase 20 router/narrative mechanics and Phase 17–19 evidence/provider infrastructure. Do not add a service or dependency.

Validate complete rooted graphs before attribution. Use interval unions for direct-child coverage, then partition the observed root envelope into nonoverlapping intervals with deterministic latest-finishing active-child selection. Name this an estimated dominant envelope, not a verified causal critical path. Preserve per-service inclusive unions separately and suppress attribution for incomplete/skewed graphs. Uncovered parent time remains unattributed.

Keep findings/priorities deterministic and evidence-referenced. Optional constrained AI changes only an allowed summary. Missing exporters and sampled SQL/window limitations remain explicit partial coverage. No SQL/EXPLAIN or autonomous remediation is triggered.

## Consequences

Existing hosts and packages remain sufficient and compatibility tests cover the shared extraction. The estimate is mathematically bounded by root duration but cannot predict optimization gains or workload percentile contributions. Trace IDs must be supplied. More precise causal analysis would require separately reviewed scheduling/link instrumentation and a new algorithm version. Default resource/queue and remote SQL coverage remain unavailable rather than invented.
