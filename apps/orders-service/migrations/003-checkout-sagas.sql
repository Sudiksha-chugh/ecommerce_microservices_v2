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

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN ('PENDING','CONFIRMED','FAILED','CANCELLED'));
CREATE TABLE checkout_sagas (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL UNIQUE REFERENCES orders(id), user_id UUID NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('CREATED','INVENTORY_PENDING','INVENTORY_RESERVED','PAYMENT_PENDING','PAYMENT_RECONCILIATION_REQUIRED','PAYMENT_SUCCEEDED','INVENTORY_CONFIRMATION_PENDING','COMPLETED','COMPENSATION_PENDING','COMPENSATED','FAILED','MANUAL_REVIEW_REQUIRED')),
 version BIGINT NOT NULL DEFAULT 0 CHECK(version>=0), inventory_reservation_id UUID, payment_id UUID,
 reservation_operation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(), payment_operation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 correlation_id UUID NOT NULL, last_error TEXT, next_action_at TIMESTAMPTZ,
 locked_by TEXT, locked_until TIMESTAMPTZ, claim_token UUID, retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
 pending_command JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
 CHECK((claim_token IS NULL)=(locked_until IS NULL)), CHECK((claim_token IS NULL)=(locked_by IS NULL))
);
CREATE INDEX checkout_sagas_due ON checkout_sagas(next_action_at) WHERE next_action_at IS NOT NULL;
CREATE INDEX checkout_sagas_user ON checkout_sagas(user_id,order_id);
CREATE TABLE checkout_saga_transitions (
 sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), saga_id UUID NOT NULL REFERENCES checkout_sagas(id),
 from_state TEXT, to_state TEXT NOT NULL, trigger_event_id UUID, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX checkout_saga_transitions_history ON checkout_saga_transitions(saga_id,sequence);

-- Keep Phase 11's single order-created event guarantee, while allowing step retries.
DROP INDEX orders_created_event_unique;
CREATE UNIQUE INDEX orders_created_event_unique ON outbox_events(aggregate_id,event_type,event_version) WHERE event_type='order.created';
