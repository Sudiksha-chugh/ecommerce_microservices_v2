CREATE TABLE refunds (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), payment_id UUID NOT NULL REFERENCES payments(id), order_id UUID NOT NULL,
 principal_id UUID NOT NULL, user_id UUID NOT NULL, amount_paise BIGINT NOT NULL CHECK(amount_paise BETWEEN 1 AND 9007199254740991),
 currency VARCHAR(3) NOT NULL CHECK(currency='INR'),
 status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','PROCESSING','SUCCEEDED','FAILED','REQUIRES_RECONCILIATION','MANUAL_REVIEW_REQUIRED')),
 reason TEXT NOT NULL CHECK(reason IN ('ADMIN_REQUEST','CUSTOMER_CANCELLATION','PAID_UNFULFILLED')),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 255), request_fingerprint TEXT NOT NULL,
 provider_refund_id TEXT UNIQUE, provider_operation_id UUID NOT NULL UNIQUE, correlation_id UUID NOT NULL,
 command JSONB, lease_token UUID, lease_expires_at TIMESTAMPTZ, retry_count INTEGER NOT NULL DEFAULT 0,
 next_action_at TIMESTAMPTZ DEFAULT NOW(), last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
 UNIQUE(principal_id,idempotency_key), CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CHECK((status IN ('SUCCEEDED','FAILED'))=(completed_at IS NOT NULL))
);
CREATE INDEX refunds_payment ON refunds(payment_id,created_at,id);
CREATE INDEX refunds_recovery ON refunds(next_action_at) WHERE next_action_at IS NOT NULL;
CREATE TABLE refund_attempts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),refund_id UUID NOT NULL REFERENCES refunds(id),attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
 provider_operation_id UUID NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('PROCESSING','SUCCEEDED','FAILED','UNKNOWN')),failure_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(refund_id,attempt_number)
);
CREATE TABLE refund_transitions (
 sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,refund_id UUID NOT NULL REFERENCES refunds(id),from_state TEXT,to_state TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
