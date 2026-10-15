# ADR 014: Event-Driven Elasticsearch Search Projection

Status: Accepted for Phase 16, opt-in.

## Context

Catalog owns publicly readable UUID products and hard deletion in PostgreSQL. It had no product events, versions, categories, stock/visibility state or search architecture. Search needs relevance and typo tolerance while Catalog writes and business recovery remain independent of Elasticsearch.

## Decision

Use a dedicated Search service and rebuildable Elasticsearch read model. PostgreSQL remains authoritative. Catalog's explicit migration installs atomic version/journal/Outbox capture in the product transaction. The existing confirmed RabbitMQ Outbox publisher and durable/manual-ACK retry/DLQ infrastructure carry complete, signed product projections. Search consumes asynchronously and acknowledges after indexing plus durable receipt bookkeeping. No direct Elasticsearch write occurs in Catalog's transaction.

Monotonic product versions and deterministic document IDs protect duplicates/concurrent/out-of-order delivery. Elasticsearch external versions enforce ordering atomically. Deletion remains a persistent hidden document, backed by durable Catalog/Search tombstones, rather than depending on Elasticsearch's expiring delete markers. Explicit mappings preserve integer money and allowlisted public query generation.

Rebuilds use a signed, bounded internal Catalog API, not Catalog database credentials. A transactional committed sequence and immutable change journal capture snapshot races. Register the candidate before the initial watermark, replay changes through a later watermark, verify/audit, then atomically replace the read alias. Keep older generations for audited catch-up rollback and explicit cleanup. Persist progress and coordinate workers with database advisory locks; repeat after crash safely.

Public results receive an authoritative Catalog existence check, failing closed during lookup outage. This suppresses hard-deleted products during indexing lag while retaining eventual consistency for ordinary searchable fields. Future restricted statuses must extend Catalog's visibility policy before public exposure. Inventory remains separate.

All Search, indexing, rebuild and Catalog publication/export flags default off. Elasticsearch is not a dependency of existing application operations. The Gateway adds only optional public routing and uses the existing distributed Redis SEARCH policy. Full telemetry rollout remains Phase 17.

## Consequences

Search adds independent PG/broker/Elasticsearch operational state and consistency lag, not a second product authority. Outages preserve journal/Outbox/broker/receipt evidence but may exceed finite retries into operator-reviewed DLQ. Persistent tombstones prevent stale resurrection at the cost of retention/storage management. Cross-service database access would break ownership and is prohibited.

Live search_after cursors are encrypted/query-bound/time-limited but not PIT snapshots. Rebuild catch-up plus dual writes prevents lost mutations, rather than claiming every concurrent write is instantly searchable. Source checks add availability/latency cost for deletion safety. Local pinned Elasticsearch 8.15.0/Node 24 REST integration, development security settings and VM behavior do not constitute a production HA/support/load benchmark. Automatic pruning, inventory/status/category architecture and managed deployment are deferred.

See [Search architecture and operations](../event-driven-search.md), [Elasticsearch external versioning](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/docs-index_.html), and [atomic alias actions](https://www.elastic.co/guide/en/elasticsearch/reference/current/aliases.html).
