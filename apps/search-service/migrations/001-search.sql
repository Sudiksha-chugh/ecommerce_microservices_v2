CREATE TABLE search_projection_state(id UUID PRIMARY KEY,version BIGINT NOT NULL CHECK(version>0),document JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
CREATE TABLE search_receipts(event_id UUID PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PENDING','DONE')),occurred_at TIMESTAMPTZ NOT NULL,completed_at TIMESTAMPTZ);
CREATE TABLE search_targets(index_name TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('CANDIDATE','ACTIVE','RETAINED','LOST')),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
CREATE TABLE search_jobs(id UUID PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('REBUILD','RECONCILE','ROLLBACK')),status TEXT NOT NULL DEFAULT 'PREPARING' CHECK(status IN ('PREPARING','SNAPSHOT','CATCH_UP','VERIFYING','AUDITING','SWAPPING','PAUSED','COMPLETE')),
 index_name TEXT NOT NULL,principal UUID NOT NULL,initial_watermark BIGINT,catchup_watermark BIGINT,snapshot_cursor TEXT NOT NULL DEFAULT '',change_cursor TEXT,
 verify_cursor TEXT NOT NULL DEFAULT '',audit_cursor TEXT NOT NULL DEFAULT '',unresolved BIGINT NOT NULL DEFAULT 0,processed BIGINT NOT NULL DEFAULT 0,mismatches BIGINT NOT NULL DEFAULT 0,retries INTEGER NOT NULL DEFAULT 0,last_error TEXT,paused_from TEXT,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),completed_at TIMESTAMPTZ);
CREATE UNIQUE INDEX one_active_search_job ON search_jobs((true)) WHERE status<>'COMPLETE';
CREATE TABLE search_audit(id BIGSERIAL PRIMARY KEY,job_id UUID NOT NULL REFERENCES search_jobs(id),principal UUID NOT NULL,operation TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
