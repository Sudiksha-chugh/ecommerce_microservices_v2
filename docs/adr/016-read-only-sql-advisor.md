# ADR 016: Evidence-grounded SQL advice within observability

Status: accepted for Phase 19 implementation.

Phase 18 already owns sampled telemetry, approved read-only generic plans, filtered findings, and admin-authorized reporting. Reuse these interfaces within its package instead of introducing a new service or exposing arbitrary query submission.

Build deterministic advice first. Optional isolated providers may select reviewed literal narrative elaborations but must preserve evidence, limitations and priority. Enforce schemas, numeric/enumerated snapshots, input/output limits, finite budgets, bounded caches and no execution tools. Keep ordinary business processes deterministic, with optional AI confined to the existing explicitly started loopback diagnostics process.

Telemetry is process-local and generic template plans are not correlated with workload digests. Expose both contexts honestly instead of joining by guesswork. No ingestion endpoint or data extraction is introduced. This sacrifices automatic combined workload/plan analysis until a trustworthy mapping and transport are designed. It preserves the privacy boundary and prevents fabricated evidence.

Model output prose must match source-specific reviewed narrative choices. Keyword filtering alone cannot prevent invented facts such as assertions that an index is absent. This constrains natural language variety while allowing fuller explanations and validation guidance without granting a model authority to invent evidence.
