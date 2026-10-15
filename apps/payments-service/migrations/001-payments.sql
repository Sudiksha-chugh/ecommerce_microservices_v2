CREATE TABLE payments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL UNIQUE,
 user_id UUID NOT NULL, created_by UUID NOT NULL,
 amount_paise BIGINT NOT NULL CHECK (amount_paise BETWEEN 1 AND 9007199254740991),
 currency VARCHAR(3) NOT NULL CHECK (currency = 'INR'),
 status VARCHAR(30) NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','PROCESSING','SUCCEEDED','FAILED','REQUIRES_RECONCILIATION')),
 idempotency_key VARCHAR(255) NOT NULL, request_fingerprint TEXT NOT NULL,
 provider_payment_id VARCHAR(255) UNIQUE,
 lease_token UUID, lease_expires_at TIMESTAMPTZ,
 next_reconcile_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE (created_by, idempotency_key), UNIQUE (user_id, idempotency_key),
 CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE TABLE payment_attempts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), payment_id UUID NOT NULL REFERENCES payments(id),
 attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
 status VARCHAR(30) NOT NULL CHECK (status IN ('PROCESSING','SUCCEEDED','FAILED','UNKNOWN')),
 provider_request_id VARCHAR(255) NOT NULL UNIQUE, failure_code VARCHAR(100),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE (payment_id, attempt_number)
);
CREATE INDEX payments_user_created_index ON payments (user_id, created_at DESC);
CREATE INDEX payments_reconcile_index ON payments (status, next_reconcile_at, lease_expires_at);
