import type { Pool } from 'pg';
import type { Product } from '@ecommerce/contracts';

import type { CreateProductInput, UpdateProductInput } from './product-validation.js';

export class DatabaseUnavailableError extends Error {}
export class DatabaseOperationError extends Error {}

// pg returns bigint as strings; this cast is exact within the database's safe-integer constraint.
const productColumns = 'id, name, description, price_in_paise::double precision AS "priceInPaise"';

export class ProductRepository {
  constructor(private readonly pool: Pool) {}

  async findAll(): Promise<Product[]> {
    try {
      const result = await this.pool.query<Product>(
        `SELECT ${productColumns} FROM products ORDER BY id`,
      );
      return result.rows;
    } catch {
      throw new DatabaseUnavailableError('Catalog database unavailable');
    }
  }

  async findById(id: string): Promise<Product | undefined> {
    try {
      const result = await this.pool.query<Product>(
        `SELECT ${productColumns} FROM products WHERE id = $1`, [id],
      );
      return result.rows[0];
    } catch {
      throw new DatabaseUnavailableError('Catalog database unavailable');
    }
  }

  async create(input: CreateProductInput): Promise<Product> {
    try {
      const result = await this.pool.query<Product>(
        `INSERT INTO products (name, description, price_in_paise)
         VALUES ($1, $2, $3) RETURNING ${productColumns}`,
        [input.name, input.description, input.priceInPaise],
      );
      const product = result.rows[0];
      if (!product) throw new Error('Insert returned no product');
      return product;
    } catch {
      throw new DatabaseOperationError('Internal server error');
    }
  }

  async update(id: string, input: UpdateProductInput): Promise<Product | undefined> {
    try {
      // COALESCE preserves omitted fields; validation rejects null values.
      const result = await this.pool.query<Product>(
        `UPDATE products SET name = COALESCE($2, name),
         description = COALESCE($3, description),
         price_in_paise = COALESCE($4, price_in_paise), updated_at = clock_timestamp()
         WHERE id = $1 RETURNING ${productColumns}`,
        [id, input.name ?? null, input.description ?? null, input.priceInPaise ?? null],
      );
      return result.rows[0];
    } catch {
      throw new DatabaseOperationError('Internal server error');
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const result = await this.pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
      return result.rowCount === 1;
    } catch {
      throw new DatabaseOperationError('Internal server error');
    }
  }
}
