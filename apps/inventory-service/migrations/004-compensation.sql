ALTER TABLE inventory_reservations DROP CONSTRAINT inventory_reservations_status_check;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_status_check CHECK(status IN ('RESERVED','CONFIRMED','RELEASED','EXPIRED','RESTORED'));
ALTER TABLE inventory_reservation_requests ADD COLUMN fulfillment_blocked BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE inventory_compensations (
 order_id UUID PRIMARY KEY REFERENCES inventory_reservation_requests(order_id),compensation_operation_id UUID NOT NULL UNIQUE,
 saga_id UUID NOT NULL,user_id UUID NOT NULL,refund_operation_id UUID,
 result TEXT NOT NULL CHECK(result IN ('RELEASED','RESTORED','ALREADY_RELEASED','ALREADY_EXPIRED','ALREADY_RESTORED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
