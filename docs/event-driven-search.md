# Event-driven Elasticsearch product search

Search is an opt-in derived read model. PostgreSQL remains the authoritative Catalog store. Catalog mutations never call Elasticsearch, and Search never connects to Catalog's private database. No frontend, stock ownership, category/status model or API platform is added.

## Architecture and actual Catalog fields

Catalog owns UUID products with name, description, integer `priceInPaise`, created_at and updated_at. All existing products are public; there are no category, draft, disabled, restricted or stock fields in this schema. Deletion is hard deletion. Inventory remains the sole stock/reservation owner; search does not infer availability or change Inventory data.

After explicitly installing Catalog's new migrations, a database trigger atomically records each insert/update/delete in the shared Outbox schema and an authoritative search change journal. A separately enabled, existing OutboxWorker signs product events and publishes with RabbitMQ confirms. Search's dedicated durable consumer validates contracts/signatures, persists monotonic local projection state, updates Elasticsearch, persists a completed event receipt, and only then returns to the existing manual-ACK handler.

Search's database owns only derived projection state, receipts, index generations, operation progress and audit records. Catalog source data is accessed through bounded, signed HTTP exports. The Search API sends bounded Elasticsearch queries and performs a current Catalog existence check on result IDs before responding. API Gateway adds only the optional public `/search/products` route and composes the existing global Redis budget with SEARCH.

## Product contracts and transactional capture

The existing commerce.events exchange carries three new routing keys:

- catalog.product.created.v1
- catalog.product.updated.v1
- catalog.product.deleted.v1

Following existing conventions, envelope eventType omits `.v1` and eventVersion is 1. Required fields include eventId, occurredAt, producer catalog-service, correlationId, nullable causationId and payload. Payload includes productId, productVersion, committed changeSequence and a complete projection containing id, productVersion, name, description, priceInPaise, createdAt, updatedAt and deleted. Strict schemas reject unrelated attributes, identity/version mismatch, unsupported versions, invalid money and inappropriate deleted state. No customer PII, credentials, inventory quantities or arbitrary database fields are published.

Search indexes the first 20,000 Unicode code points of the Catalog description, bounded to 80 KB UTF-8. Catalog's original description remains unchanged; text beyond this search projection is not searchable. The shared message size bound remains in force. Money stays an integer within Catalog's existing JavaScript-safe-integer constraint and maps to an Elasticsearch long.

`003-outbox.sql` uses the existing Outbox schema. `004-search-source.sql` adds product_version, a transactional clock, current projection/tombstone rows and an immutable change journal. The BEFORE trigger obtains the clock row lock, allocates the next committed sequence, advances the durable per-product version, records the journal and inserts the Outbox envelope in the **same Catalog transaction**. A failed constraint, rollback or process crash cannot commit one side without the other. The clock uses a transactional row rather than PostgreSQL sequence allocation, so a read watermark has no uncommitted holes. Concurrent committed mutations cannot reuse a product version. Existing rows are captured as version-one snapshots during the explicitly invoked migration; subsequent seed/import SQL is captured too.

Once installed, capture occurs independently of publisher/Search feature flags. Disabling publication stops the worker, not durable capture. This prevents changes made while Search is offline from becoming invisible to a later rebuild. These additional rows require operational disk capacity and eventual safe retention work; no automatic journal pruning is implemented. Existing public Catalog response shapes remain unchanged. An unmigrated, disabled deployment continues to use its previous Catalog schema and endpoints because startup never migrates or queries Search tables by default.

## Versions, duplicates and permanent tombstones

Each Elasticsearch document ID is the Catalog product UUID. Index writes use `version_type=external` and the monotonic productVersion. Elasticsearch atomically accepts only a higher version; 409 from a duplicate/older write is harmless. There is no GET/compare/PUT concurrency algorithm.

Deletion is represented by a **permanent indexed document with deleted=true**, rather than Elasticsearch DELETE. Public queries force deleted=false. This avoids the retention limit of Elasticsearch's ordinary deletion tombstones: an old update cannot recreate a document after gc_deletes expires. Catalog retains the same durable tombstone/version in its source journal; Search retains monotonic local state. Rebuilds restore tombstones as well as live products. Legitimate recreation of the same UUID advances beyond the deleted version; the public create API does not accept caller-chosen UUIDs.

Event receipts are keyed by immutable eventId plus a canonical business-envelope fingerprint. Repeated transport delivery is harmless; a reused ID with changed content is rejected. Receipt DONE does not skip necessary Elasticsearch repair: a derived index can be lost, so replay always reapplies the latest remembered version. Concurrent handlers use atomic PostgreSQL upserts and Elasticsearch external versions. No Elasticsearch call runs inside a Catalog transaction. ACK occurs after writes to registered generations and completed receipt persistence. A crash after indexing but before bookkeeping/ACK replays safely.

Per-generation write aliases and `require_alias=true` prevent missing physical indexes from being silently recreated with dynamic mappings. Losing an active/candidate index remains an enforcement/indexing outage requiring rebuild/resume. A confirmed missing retained generation can be marked LOST and excluded from future event writes; it cannot be rolled back to. No live product is silently deleted as a repair.

## Mappings and queries

Mappings are explicit and dynamic=strict:

- id: keyword, also the stable sort tie-breaker.
- name: standard-analyzed text with a keyword multi-field.
- description: standard-analyzed text.
- priceInPaise and productVersion: long.
- createdAt and updatedAt: date.
- deleted: boolean.

Query DSL is generated by the service, never accepted from clients. Multi-match bool_prefix searches name (boost four) and description, with bounded AUTO:4,7 fuzziness, prefix_length one and max_expansions twenty. Name matches rank above description matches. The last token supports prefix matching; other terms support typo tolerance. No unrestricted wildcard or script query is exposed. Elasticsearch search itself is bounded and disallows partial shard results; a timeout/outage returns service unavailable, never a misleading successful empty page.

## Public API, filtering and pagination

GET `/search/products` through an enabled Gateway or the Search service accepts only:

- q: trimmed text, maximum 120 characters; omitted/empty lists public products.
- minPrice/maxPrice: nonnegative integer **paise**, maximum Number.MAX_SAFE_INTEGER; reversed ranges rejected.
- createdAfter/createdBefore: ISO timestamps, ordered range.
- sort: relevance, price_asc, price_desc or newest.
- limit: default 20, maximum 100 (configurable lower maximum).
- cursor: opaque continuation token, maximum 2048 characters.

Category, stock/status filters and arbitrary DSL/sort fields are rejected because those attributes/APIs do not exist. Successful responses follow the existing Product shape inside `{data, pagination:{limit,nextCursor}}`. Internal Elasticsearch IDs, scores, versions and index names are omitted from public responses.

Every sort includes id ascending as its stable tie-breaker. Pagination uses search_after rather than unbounded from/size. Cursors are authenticated/encrypted with AES-256-GCM and a configured 32+ character secret, bind the complete validated query and page size, and expire after sixty seconds. Tampering, changing filters/limit/sort, malformed values and expiry return 400. Clients must treat the token as opaque and repeat the same query. A full raw page may yield an empty next page; visibility suppression can leave a short/empty page with a cursor that still advances.

This is live-view pagination, not a PIT snapshot: concurrent indexing can move items between pages. Stable order and no duplicates are guaranteed for a quiescent index, not across arbitrary concurrent mutations. Use synchronized service clocks and a common cursor key across instances. Snapshot-consistent PIT pagination and longer-lived cursors are deferred.

## Authoritative visibility and availability

An indexed result must be nondeleted **and currently exist in Catalog**. Search signs a bounded `/internal/catalog/search-visible?ids=...` GET and fails closed if that authoritative read is unavailable. Deleted products whose deletion event is delayed are therefore suppressed before responding. The check reflects Catalog at the check's read instant; a concurrent deletion after that read has the same ordinary read race as Catalog's own public endpoint.

Name, description, price and relevance remain eventually consistent until events/catch-up apply; existence checking does not turn Elasticsearch into a synchronous authoritative product read. If future migrations introduce draft/disabled/private products, Catalog's visibility check and contracts must implement those rules before indexing/exposing them. There is no existing restricted status to invent in this phase. Search never infers stock from Catalog or stale search state.

Public Search returns 503 SEARCH_UNAVAILABLE on Elasticsearch/authoritative lookup outage, with no successful empty data payload. Gateway preserves service errors and returns its established 502/504 when Search itself is unavailable/times out. Its default five-second budget covers two sequential bounded two-second Search RPCs plus response overhead; other Gateway timeouts remain unchanged.

## Broker, outages and recovery

Search owns only search.product-events.v1, its retry/DLQ queues and commerce.search.handoff, bound to the three product event keys. Existing quorum/manual ACK/prefetch/confirmed handoff/reconnect conventions are reused. Prefetch is bounded to 1–20. Malformed/unsupported/forged events are permanent failures; transient HTTP/PG errors use the finite existing retry schedule, then durable DLQ. No unbounded in-memory retry queue is added.

Catalog publishing and consumption have separate opt-ins and credentials. The optional broker provisioner creates catalog publication permissions for the three product types and Search read/bind permissions for those types only, with no Search publication to commerce.events or consumption of another service queue. Provisioning was not run against the development broker.

Elasticsearch loss cannot roll back Catalog mutations. Outbox, journal, broker/DLQ and Search receipts retain work. A send timeout may have applied an index write; repeating the same version safely gets 409 or applies the missing write. Long outages exceeding broker retries require reviewed replay and/or authoritative reconciliation/rebuild. A completed rebuild repairs current state, while event/DLQ audit receipts still require appropriate replay/review. No claim of never needing operators or universal exactly-once delivery is made.

## Private source APIs and data ownership

Catalog explicitly enables these read-only internal GET endpoints:

- `/internal/catalog/search-watermark`: committed journal watermark.
- `/internal/catalog/search-export`: mode state/changes, through watermark, bounded limit 1–100, validated keyset cursor.
- `/internal/catalog/search-documents`: bounded canonical projection lookup including durable tombstones, for audit.
- `/internal/catalog/search-visible`: bounded IDs currently present in products.

The existing timestamped HMAC convention now supports a distinct search caller without changing Notifications' default signature bytes. Signature binds caller, method, complete path/query and timestamp with a thirty-second window. Customer/admin JWTs or internal-looking headers alone cannot authorize exports. The source is not exposed through Gateway. Export order is UUID for state and committed sequence for changes; all schemas/parameters are explicit and bounded. Search's PG role cannot connect to Catalog's database.

## Durable rebuild and zero-downtime replacement

Admin requests create a durable job and audit principal. One active operation is admitted by an advisory lock plus a unique database constraint. A session advisory lock coordinates worker instances; it is released by process death. Work advances one bounded page per poll and persists cursors only after the page's writes succeed. Repeated pages are safe. Dependency failure persists capped exponential backoff; after ten failures the job pauses for operator review/resume at its recorded phase.

The phases are PREPARING, SNAPSHOT, CATCH_UP, VERIFYING, AUDITING, SWAPPING and COMPLETE (or PAUSED):

1. Create a uniquely versioned physical index with strict mappings and its write alias.
2. Commit candidate registration **before** reading Catalog's initial watermark. Consumers now write active/candidate/retained generations.
3. Export current rows with sequence ≤ initial watermark using bounded UUID keysets. A row changed during export may disappear from this bounded snapshot, but its change is retained in the immutable journal.
4. After snapshot pages finish, capture a catch-up watermark and replay every change between the initial and catch-up watermarks. New products, multiple updates and deletions are all included. External versions prevent an older snapshot from overwriting newer event writes.
5. Verify/repair authoritative versions in bounded pages, then scan candidate documents and check canonical source records. Unknown/ahead/unrepairable documents are reported; a replacement with unresolved mismatches is not activated.
6. Refresh the candidate and perform one atomic remove-old/add-new alias operation; verify the resulting single alias target.
7. Commit operation completion/new ACTIVE/old RETAINED metadata. Crash after alias change but before this commit repeats the same safe switch and completes bookkeeping.

The old read alias continues serving while the candidate loads. Every source commit up to the catch-up watermark is accounted for before activation. Later commits use the same ordinary event-driven eventual consistency and are dual-written to the registered candidate/new active generation, rather than lost at replacement. This guarantees no committed mutation is discarded by the snapshot/swap race; it does not claim instant visibility of every write committed while an asynchronous consumer is lagging.

Retained generations also receive events. An explicit rollback job targets only a recorded retained generation, repeats authoritative snapshot/catch-up/verification before switching, and audits its principal. Retention is capped at five registered generations; operator-controlled cleanup is required before growth beyond that. Cleanup selects a durable job ID, validates retained ownership/no active job/no current alias, deletes only that exact derived index and records an audit. It is not a public arbitrary-index deletion API. If cleanup crashes after Elasticsearch deletion, repeat the same operation. Never manually redirect aliases or mutate protected hashes/documents while the coordinator is operating.

## Reconciliation and administration

Reconciliation scans authoritative projections in bounded pages, repairs missing/stale/deleted-state mismatches, catches up changes, and audits index documents against the private source. Unknown documents/versions and unexpected contents are reported without unverified deletion. Same-version/external-version corruption may require a fresh rebuild rather than a version downgrade. Source journal/tombstones remain authoritative throughout.

All `/admin/search` routes verify the shared admin JWT. Customers get 403; missing/invalid credentials get 401. Read-only status/metrics are available with active Search features; mutation operations additionally require SEARCH_REBUILD_ENABLED. Bodies are empty strict objects, and IDs are validated UUIDs:

- POST `/admin/search/rebuild` or `/reconcile`: 202 operation ID.
- GET `/admin/search/rebuild/:id`: durable progress/status.
- GET `/admin/search/index-status`: bounded recent jobs, targets, pending receipt count.
- POST `/admin/search/rebuild/:id/resume`: explicitly resume a paused phase.
- POST `/admin/search/rollback/:id`: catch up and roll back to that completed retained generation.
- DELETE `/admin/search/retained/:id`: explicit cleanup of a recorded retained generation.
- GET `/admin/search/metrics`: structured local metrics.

No destructive route accepts an arbitrary index name. Preserve operator records before review/replay. Restrict direct service origins so external clients cannot bypass Gateway rate limiting. Admin operations are not publicly forwarded by Gateway.

## Flags, setup and Compose

All default false: SEARCH_ENABLED, SEARCH_INDEXING_ENABLED, SEARCH_REBUILD_ENABLED, CATALOG_SEARCH_EXPORT_ENABLED and CATALOG_SEARCH_PUBLISH_ENABLED. Existing checkout/refund/Notification flags are unchanged. Disabled Search/Gateway routing does not make Elasticsearch a dependency of Catalog or the wider application.

`.env.search.example` documents service configuration. Shared keys must be distinct and 32+ characters; use the same public JWT settings as Auth. Validate endpoint origins without embedded HTTP credentials, alias prefixes, page sizes, command deadlines, broker prefetch and enabled-mode requirements before startup. A Search Elasticsearch API key is optional for local fixtures; nonlocal deployments need TLS, authenticated Elasticsearch and narrowly scoped credentials. Catalog publishing uses its separate MESSAGING_URL/service role and CATALOG_EVENT_KEY; enabling the generic messaging flag alone does not enable this publisher.

The optional `search` Compose profile uses Node 24.21.0 and **Elasticsearch 8.15.0**, matching the cached local image and verified 8.x REST APIs; there is no unbounded latest tag or additional JavaScript SDK dependency. Search port 4008, dedicated PG host 5441 and Elasticsearch 9210 avoid existing allocations. Existing PG/Redis/RabbitMQ ports and volumes are unchanged. Persistent Search volumes are separate; no migration runs on startup. Local Elasticsearch security is disabled with loopback host binding, so this profile is for controlled local development, not an authenticated production deployment. Version/support/security upgrades and production rollout require separate review.

Before enabling on a development store, obtain explicit migration authorization, apply the Catalog/Search migrations, provision the exchange/restricted queue credentials, enable the private export/publisher as intended, perform the initial admin rebuild, and enable public Search. This phase did not migrate development databases or enable any of these flags.

## Observability, testing and limitations

Structured logs include event/correlation/product/version IDs, retry counts, indexing/search duration, generated request IDs and rebuild ID/phase/index/error code. Queries, tokens, passwords, connection URLs and full product bodies are not logged. Low-cardinality process-local counters cover search requests/duration, indexed events/failures, actual broker DLQ handoff, observed projection lag, rebuild duration and reconciliation mismatches. Product/request IDs are not metric labels. Metrics are not a fleet-wide exporter or full OpenTelemetry deployment; those belong to Phase 17.

Vitest/Supertest use real Elasticsearch, private PG roles and a fresh RabbitMQ broker through `compose.search-test.yaml`. Projects are uniquely named, use random localhost ports and tmpfs, and do not reference development volumes. Each case clears only its own test data/generations. A functional mapping/index/search preflight supplements cluster health. SIGKILL/HTTP/TCP/database interruption logic lives only in test fixtures, not production flags. Use Node.js 24 and Docker:

```sh
npm run typecheck
npm run test:search
npm test -- apps/api-gateway/test
npm run notifications:test:up
npm test -- --silent
npm run notifications:test:down
npm run search:smoke
npm run search:restart-check
npm run test:isolated -- --reporter=json --outputFile=/tmp/phase-16-full.json
```

The smoke runner builds the actual optional profile with disposable overrides, generated keys, a real private Catalog source, restricted broker identity and fresh migrations, checks disabled defaults before temporary activation, then exercises rebuild, delivery, alias replacement and shutdown. It removes only its generated project/files. Cold JVM initialization is a separate, instrumented preflight; two-second application request budgets and all legacy test settings are unchanged; the new multi-service scenarios have an explicit twenty-second total budget for multiple independently bounded operations. The local VM exhibited heavy host swapping and unusually slow JVM startup. Exact passed/failed/unexecuted results and remaining environmental limitations are in the Phase 16 report; unexecuted cases are never counted as passes. The isolated container regression runner now provisions a dedicated Search PostgreSQL cluster and broker vhost plus Elasticsearch, while keeping all test processes in the store network namespace. Tests receive no Docker socket; host mode remains available for physical restart checks. Its executed results are recorded separately from host-forwarded runs in the Phase 16 report.

Operational limits: public results can lag field changes; live cursors lack snapshot consistency; multiple active writers to protected indexes can corrupt external-version state; Redis/Search/Elasticsearch loss and long broker outages may require operators. Source journal, tombstones, receipts and audit records have no automatic retention/pruning. Index/data sizes and traffic require capacity planning. No inventory/category/status model, relevance benchmark, managed Elastic deployment, production HA/load test, API platform, frontend or later-phase observability rollout is included.
