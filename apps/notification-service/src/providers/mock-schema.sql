CREATE TABLE IF NOT EXISTS mock_email_deliveries (
 operation_id UUID PRIMARY KEY,request_fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('ACCEPTED','TRANSIENT','PERMANENT','UNKNOWN')),
 provider_message_id UUID UNIQUE,send_calls INTEGER NOT NULL DEFAULT 1,lookup_calls INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK((status='ACCEPTED')=(provider_message_id IS NOT NULL))
);
