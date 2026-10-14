import type {SagaKeys} from '@ecommerce/messaging';
import {startSaga} from './saga/repository.js';
import { insertOutbox, createEvent } from '@ecommerce/event-persistence';
import type { Pool, PoolClient } from 'pg';
import type { Order, OrderItem, OrderSummary } from '@ecommerce/contracts';
import { databaseMoney } from './money.js';
import { OrderDatabaseError, OrderError } from './errors.js';

interface OrderRow {
  id: string; user_id: string; status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED'; total_amount_paise: string;
  request_fingerprint: string; created_at: Date; updated_at: Date;
}
interface ItemRow {
  product_id: string; product_name: string; unit_price_paise: string;
  quantity: number; line_total_paise: string;
}
export interface CheckoutSnapshot { items: OrderItem[]; totalAmountInPaise: number }
export interface StoredOrder { order: Order; fingerprint: string }
const columns = 'id, user_id, status, total_amount_paise::text, request_fingerprint, created_at, updated_at';
function summary(row: OrderRow): OrderSummary {
  return { id: row.id, userId: row.user_id, status: row.status,
    totalAmountInPaise: databaseMoney(row.total_amount_paise),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function isKeyConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
    && 'constraint' in error && error.constraint === 'orders_user_id_idempotency_key_unique';
}

export class OrderRepository {
  constructor(private readonly pool: Pool) {}
  private async items(orderId: string, userId: string): Promise<OrderItem[]> {
    const result = await this.pool.query<ItemRow>(`SELECT i.product_id, i.product_name,
      i.unit_price_paise::text, i.quantity, i.line_total_paise::text
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.id = $1 AND o.user_id = $2 ORDER BY i.product_id`, [orderId, userId]);
    return result.rows.map((item) => ({ productId: item.product_id, productName: item.product_name,
      unitPriceInPaise: databaseMoney(item.unit_price_paise), quantity: item.quantity,
      lineTotalInPaise: databaseMoney(item.line_total_paise) }));
  }
  async findByKey(userId: string, key: string): Promise<StoredOrder | undefined> {
    try {
      const row = (await this.pool.query<OrderRow>(`SELECT ${columns} FROM orders
        WHERE user_id = $1 AND idempotency_key = $2`, [userId, key])).rows[0];
      if (!row) return undefined;
      return { order: { ...summary(row), items: await this.items(row.id, userId) }, fingerprint: row.request_fingerprint };
    } catch { throw new OrderDatabaseError(); }
  }
  async findById(userId: string, id: string): Promise<Order | undefined> {
    try {
      const row = (await this.pool.query<OrderRow>(`SELECT ${columns} FROM orders WHERE id = $1 AND user_id = $2`, [id, userId])).rows[0];
      if (!row) return undefined;
      return { ...summary(row), items: await this.items(row.id, userId) };
    } catch { throw new OrderDatabaseError(); }
  }
  async findAll(userId: string, limit: number, offset: number): Promise<OrderSummary[]> {
    try {
      return (await this.pool.query<OrderRow>(`SELECT ${columns} FROM orders WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [userId, limit, offset])).rows.map(summary);
    } catch { throw new OrderDatabaseError(); }
  }
  async create(userId: string, key: string, fingerprint: string, snapshot: CheckoutSnapshot, checkoutKeys?: SagaKeys): Promise<Order> {
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch { throw new OrderDatabaseError(); }
    let discard = false;
 const onClientError = () => { discard = true; }; client.on('error', onClientError);
    let conflict = false;
    let order: Order | undefined;
    try {
      await client.query('BEGIN');
      const row = (await client.query<OrderRow>(`INSERT INTO orders
        (user_id, total_amount_paise, idempotency_key, request_fingerprint)
        VALUES ($1, $2, $3, $4) RETURNING ${columns}`,
        [userId, String(snapshot.totalAmountInPaise), key, fingerprint])).rows[0];
      if (!row) throw new OrderDatabaseError();
      await client.query(`INSERT INTO order_items
        (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
        SELECT $1::uuid, item.product_id, item.product_name, item.unit_price_paise, item.quantity, item.line_total_paise
        FROM UNNEST($2::uuid[], $3::text[], $4::bigint[], $5::integer[], $6::bigint[])
        AS item(product_id, product_name, unit_price_paise, quantity, line_total_paise)`,
        [row.id, snapshot.items.map((item) => item.productId), snapshot.items.map((item) => item.productName),
          snapshot.items.map((item) => String(item.unitPriceInPaise)), snapshot.items.map((item) => item.quantity),
          snapshot.items.map((item) => String(item.lineTotalInPaise))]);
      const persistedItems = (await client.query<ItemRow>(`SELECT product_id, product_name, unit_price_paise::text,
        quantity, line_total_paise::text FROM order_items WHERE order_id=$1 ORDER BY product_id`, [row.id])).rows;
      const event = createEvent('order.created', { orderId: row.id, userId: row.user_id,
        totalAmountPaise: databaseMoney(row.total_amount_paise), currency: 'INR',
        items: persistedItems.map((item) => ({ productId: item.product_id, quantity: item.quantity })),
        createdAt: row.created_at.toISOString() }, undefined, row.created_at.toISOString());
      await insertOutbox(client, event, row.id);
      if(checkoutKeys){
        if(snapshot.totalAmountInPaise<=0)throw new OrderError(422,'Checkout requires a positive total');
        await startSaga(client,row.id,userId,snapshot.items.map(({productId,quantity})=>({productId,quantity})),checkoutKeys);
      }
      order = { ...summary(row), items: snapshot.items };
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      if (!discard && isKeyConflict(error)) conflict = true;
      else if(error instanceof OrderError)throw error;
      else throw new OrderDatabaseError();
    } finally { client.release(discard); client.off('error', onClientError); }
    // Release the transaction client before a replay lookup, even with a pool of size one.
    if (conflict) {
      const existing = await this.findByKey(userId, key);
      if (!existing) throw new OrderDatabaseError();
      if (existing.fingerprint !== fingerprint) throw new OrderError(409, 'Idempotency key conflicts with another checkout snapshot');
      return existing.order;
    }
    if (!order) throw new OrderDatabaseError();
    return order;
  }
}
