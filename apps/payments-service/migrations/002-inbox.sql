CREATE TABLE inbox_events (
 consumer_name TEXT NOT NULL CHECK (length(consumer_name) BETWEEN 1 AND 255),
 event_id UUID NOT NULL,
 event_type TEXT NOT NULL,
 event_version INTEGER NOT NULL CHECK (event_version > 0),
 correlation_id UUID NOT NULL,
 causation_id UUID,
 event_fingerprint TEXT NOT NULL,
 processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (consumer_name,event_id)
);
CREATE INDEX inbox_processed_index ON inbox_events (processed_at,event_id);
