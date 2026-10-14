CREATE TABLE IF NOT EXISTS mock_refunds (
 operation_id UUID PRIMARY KEY,payment_request_id UUID NOT NULL REFERENCES mock_charges(request_id),amount_paise BIGINT NOT NULL CHECK(amount_paise BETWEEN 1 AND 9007199254740991),
 currency VARCHAR(3) NOT NULL CHECK(currency='INR'),status TEXT NOT NULL CHECK(status IN ('SUCCEEDED','FAILED','UNKNOWN')),
 provider_refund_id UUID UNIQUE,failure_code TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK((status='SUCCEEDED')=(provider_refund_id IS NOT NULL))
);
