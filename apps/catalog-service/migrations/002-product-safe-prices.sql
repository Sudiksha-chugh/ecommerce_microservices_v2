-- JSON prices must support the full non-negative JavaScript safe-integer range.
ALTER TABLE products ALTER COLUMN price_in_paise TYPE BIGINT;
ALTER TABLE products ADD CONSTRAINT products_price_safe_integer
  CHECK (price_in_paise <= 9007199254740991);
