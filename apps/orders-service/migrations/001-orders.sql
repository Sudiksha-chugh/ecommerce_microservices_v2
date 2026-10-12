CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status = 'PENDING'),
  total_amount_paise BIGINT NOT NULL CHECK (total_amount_paise BETWEEN 0 AND 9007199254740991),
  idempotency_key VARCHAR(255) NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT orders_user_id_idempotency_key_unique UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_user_created_at_index ON orders (user_id, created_at DESC, id DESC);
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  unit_price_paise BIGINT NOT NULL CHECK (unit_price_paise BETWEEN 0 AND 9007199254740991),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total_paise BIGINT NOT NULL CHECK (line_total_paise BETWEEN 0 AND 9007199254740991),
  CHECK (line_total_paise::numeric = unit_price_paise::numeric * quantity),
  UNIQUE (order_id, product_id)
);
-- The unique index above also supports order_id lookups (its leading column).
