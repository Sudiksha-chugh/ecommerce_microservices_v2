CREATE TABLE outbox_events (
 id UUID PRIMARY KEY,
 aggregate_id UUID,
 event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
 event_version INTEGER NOT NULL CHECK (event_version > 0),
 routing_key TEXT NOT NULL,
 producer TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 payload JSONB NOT NULL,
 envelope JSONB NOT NULL,
 correlation_id UUID NOT NULL,
 causation_id UUID,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PUBLISHED','NEEDS_ATTENTION')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 total_attempts INTEGER NOT NULL DEFAULT 0 CHECK (total_attempts >= attempts),
 publication_failures INTEGER NOT NULL DEFAULT 0 CHECK (publication_failures >= 0),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 locked_by TEXT,
 locked_until TIMESTAMPTZ,
 claim_token UUID,
 published_at TIMESTAMPTZ,
 last_error TEXT CHECK (last_error IN ('BROKER_UNAVAILABLE','UNROUTABLE','INVALID_CONTRACT','CONFIGURATION_FAILURE','LEASE_EXHAUSTED')),
 requeue_count INTEGER NOT NULL DEFAULT 0 CHECK (requeue_count >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (routing_key = event_type || '.v' || event_version::text),
 CHECK (jsonb_typeof(envelope) = 'object' AND envelope ?& ARRAY['eventId','eventType','eventVersion','occurredAt','producer','correlationId','causationId','payload']),
 CHECK (envelope->>'eventId' = id::text AND envelope->>'eventType' = event_type
   AND envelope->>'eventVersion' = event_version::text AND envelope->>'producer' = producer
   AND envelope->>'occurredAt' = occurred_at AND envelope->>'correlationId' = correlation_id::text
   AND envelope->'payload' = payload AND envelope->'causationId' = COALESCE(to_jsonb(causation_id::text),'null'::jsonb)),
 CHECK ((status='PROCESSING') = (claim_token IS NOT NULL AND locked_by IS NOT NULL AND locked_until IS NOT NULL)),
 CHECK (status='PROCESSING' OR (claim_token IS NULL AND locked_by IS NULL AND locked_until IS NULL)),
 CHECK ((status='PUBLISHED') = (published_at IS NOT NULL))
);
CREATE INDEX outbox_pending_index ON outbox_events (next_attempt_at,created_at,id) WHERE status='PENDING';
CREATE INDEX outbox_lease_index ON outbox_events (locked_until,id) WHERE status='PROCESSING';
CREATE INDEX outbox_published_index ON outbox_events (published_at,id) WHERE status='PUBLISHED';
