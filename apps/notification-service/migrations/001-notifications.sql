CREATE TABLE notifications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),source_event_id UUID NOT NULL,source_event_type TEXT NOT NULL,
 aggregate_key TEXT NOT NULL,notification_type TEXT NOT NULL CHECK(notification_type IN ('ORDER_CONFIRMED','ORDER_CANCELLED','PAYMENT_SUCCEEDED','PAYMENT_FAILED','REFUND_SUCCEEDED','REFUND_FAILED','REFUND_PENDING')),
 channel TEXT NOT NULL DEFAULT 'EMAIL' CHECK(channel='EMAIL'),category TEXT NOT NULL DEFAULT 'TRANSACTIONAL' CHECK(category IN ('TRANSACTIONAL','OPTIONAL')),
 recipient_user_id UUID,recipient_address TEXT CHECK(recipient_address IS NULL OR length(recipient_address)<=320),
 template_version INTEGER NOT NULL DEFAULT 1 CHECK(template_version>0),template_data JSONB NOT NULL,rendered_content JSONB,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','SENT','RETRY_SCHEDULED','FAILED_PERMANENTLY','DELIVERY_UNKNOWN','MANUAL_REVIEW_REQUIRED','SUPPRESSED')),
 idempotency_key TEXT NOT NULL UNIQUE,provider_operation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),correlation_id UUID NOT NULL,
 source_order_id UUID NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),reconciliation_count INTEGER NOT NULL DEFAULT 0,retry_count INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ DEFAULT NOW(),last_error_code TEXT,lease_token UUID,locked_until TIMESTAMPTZ,locked_by TEXT,superseded BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),sent_at TIMESTAMPTZ,content_purged_at TIMESTAMPTZ,
 CHECK((lease_token IS NULL)=(locked_until IS NULL)),CHECK((lease_token IS NULL)=(locked_by IS NULL)),CHECK((status='SENT')=(sent_at IS NOT NULL))
);
CREATE INDEX notifications_due ON notifications(status,next_attempt_at) WHERE next_attempt_at IS NOT NULL;
CREATE INDEX notifications_recipient ON notifications(recipient_user_id,created_at DESC,id);
CREATE INDEX notifications_source ON notifications(source_event_id);
CREATE INDEX notifications_aggregate ON notifications(aggregate_key);
CREATE TABLE notification_attempts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),notification_id UUID NOT NULL REFERENCES notifications(id),attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
 provider_operation_id UUID NOT NULL,status TEXT NOT NULL CHECK(status IN ('PROCESSING','ACCEPTED','NOT_ACCEPTED','UNKNOWN','SUPPRESSED')),
 operation_kind TEXT NOT NULL CHECK(operation_kind IN ('SEND','LOOKUP')),provider_message_id TEXT,error_code TEXT,
 started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ,duration_ms BIGINT,UNIQUE(notification_id,attempt_number)
);
CREATE TABLE notification_transitions (
 sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,notification_id UUID NOT NULL REFERENCES notifications(id),from_state TEXT,to_state TEXT NOT NULL,
 reason_code TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE notification_outcomes (
 aggregate_key TEXT PRIMARY KEY,outcome TEXT NOT NULL,user_id UUID,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE notification_preferences(user_id UUID PRIMARY KEY,optional_email_enabled BOOLEAN NOT NULL DEFAULT FALSE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE notification_retry_audit(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),notification_id UUID NOT NULL REFERENCES notifications(id),principal_id UUID NOT NULL,from_state TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
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
