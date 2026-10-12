CREATE TABLE inventory (
  product_id UUID PRIMARY KEY,
  total_stock INTEGER NOT NULL CHECK (total_stock >= 0),
  reserved_stock INTEGER NOT NULL DEFAULT 0 CHECK (reserved_stock >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (reserved_stock <= total_stock)
);
-- One durable fingerprint and serialization point for an entire order request.
CREATE TABLE inventory_reservation_requests (
  order_id UUID PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES inventory_reservation_requests(order_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory(product_id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status VARCHAR(30) NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, product_id)
);
CREATE INDEX inventory_reservations_expiry_index ON inventory_reservations (status, expires_at);
CREATE INDEX inventory_reservations_product_index ON inventory_reservations (product_id);
-- UNIQUE (order_id, product_id) supplies an order_id-leading lookup index.
