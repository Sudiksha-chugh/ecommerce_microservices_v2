import type { Pool } from 'pg';

export async function seed(pool: Pool) {
  // Stable development UUIDs make repeated seeds idempotent without a name uniqueness constraint.
  await pool.query(`INSERT INTO products (id, name, description, price_in_paise)
    VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)
    ON CONFLICT (id) DO NOTHING`, [
    '11111111-1111-4111-8111-111111111111', 'Notebook', 'A ruled paper notebook.', 14900,
    '22222222-2222-4222-8222-222222222222', 'Coffee mug', 'A ceramic coffee mug.', 29900,
    '33333333-3333-4333-8333-333333333333', 'Desk lamp', 'A compact reading lamp.', 129900,
  ]);
}
