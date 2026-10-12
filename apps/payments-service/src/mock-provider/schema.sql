CREATE TABLE IF NOT EXISTS mock_charges (
 request_id UUID PRIMARY KEY, amount_paise BIGINT NOT NULL CHECK (amount_paise BETWEEN 1 AND 9007199254740991),
 currency VARCHAR(3) NOT NULL CHECK (currency='INR'),
 status VARCHAR(30) NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','UNKNOWN')),
 provider_payment_id UUID UNIQUE, failure_code VARCHAR(100),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK ((status='SUCCEEDED') = (provider_payment_id IS NOT NULL))
);
