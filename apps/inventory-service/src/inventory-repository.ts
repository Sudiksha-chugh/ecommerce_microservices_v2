import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { InventoryStock, ReservationGroup, ReservationStatus } from '@ecommerce/contracts';
import type { ReservationInput } from './inventory-validation.js';
import { InventoryDatabaseError, InventoryError } from './errors.js';
interface ReservationRow {
  id: string; order_id: string; product_id: string; quantity: number;
  status: ReservationStatus; expires_at: Date; overdue: boolean;
}
const stockColumns = 'product_id AS "productId", total_stock AS "totalStock", reserved_stock AS "reservedStock", total_stock - reserved_stock AS "availableStock"';

export class InventoryRepository {
  constructor(private readonly pool: Pool, private readonly ttlSeconds: number) {}
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch { throw new InventoryDatabaseError(); }
    let discard = false;
 const onClientError = () => { discard = true; }; client.on('error', onClientError);
    try {
      await client.query('BEGIN'); const result = await operation(client);
      await client.query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      if (!discard && error instanceof InventoryError) throw error;
      throw new InventoryDatabaseError();
    } finally { client.release(discard); client.off('error', onClientError); }
  }
  private async lockRequest(client: PoolClient, orderId: string) {
    const row = (await client.query<{ request_fingerprint: string }>(
      'SELECT request_fingerprint, saga_id, fulfillment_blocked FROM inventory_reservation_requests WHERE order_id = $1 FOR UPDATE', [orderId],
    )).rows[0];
    if (!row) throw new InventoryError(404, 'Reservation not found');
    return row;
  }
  private async rows(client: PoolClient, orderIds: string[]): Promise<ReservationRow[]> {
    return (await client.query<ReservationRow>(`SELECT id, order_id, product_id, quantity, status, expires_at,
      expires_at <= clock_timestamp() AS overdue FROM inventory_reservations
      WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, product_id`, [orderIds])).rows;
  }
  private group(orderId: string, rows: ReservationRow[]): ReservationGroup {
    const first = rows[0];
    if (!first || rows.some((row) => row.status !== first.status)) throw new InventoryDatabaseError();
    return { orderId, status: first.status, expiresAt: first.expires_at.toISOString(),
      items: rows.map((row) => ({ id: row.id, productId: row.product_id, quantity: row.quantity,
        status: row.status, expiresAt: row.expires_at.toISOString() })) };
  }
  private async lockStock(client: PoolClient, productIds: string[]) {
    return (await client.query<InventoryStock>(`SELECT ${stockColumns} FROM inventory
      WHERE product_id = ANY($1::uuid[]) ORDER BY product_id FOR UPDATE`, [productIds])).rows;
  }
  async find(productId: string): Promise<InventoryStock | undefined> {
    try { return (await this.pool.query<InventoryStock>(`SELECT ${stockColumns} FROM inventory WHERE product_id = $1`, [productId])).rows[0]; }
    catch { throw new InventoryDatabaseError(); }
  }
  async put(productId: string, totalStock: number): Promise<InventoryStock> {
    try {
      const row = (await this.pool.query<InventoryStock>(`INSERT INTO inventory (product_id, total_stock)
        VALUES ($1, $2) ON CONFLICT (product_id) DO UPDATE
        SET total_stock = EXCLUDED.total_stock, updated_at = clock_timestamp()
        WHERE inventory.reserved_stock <= EXCLUDED.total_stock RETURNING ${stockColumns}`, [productId, totalStock])).rows[0];
      if (!row) throw new InventoryError(409, 'Stock cannot be lower than reserved quantity');
      return row;
    } catch (error) { if (error instanceof InventoryError) throw error; throw new InventoryDatabaseError(); }
  }
  async reserve(input: ReservationInput, transactionClient?: PoolClient, hold = false): Promise<ReservationGroup> {
    const items = [...input.items].sort((a, b) => a.productId.localeCompare(b.productId));
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: 1, items })).digest('hex');
    const operation = async (client: PoolClient) => {
      const inserted = await client.query(`INSERT INTO inventory_reservation_requests (order_id, request_fingerprint)
        VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING RETURNING order_id`, [input.orderId, fingerprint]);
      const request = await this.lockRequest(client, input.orderId);
      if (request.request_fingerprint !== fingerprint) throw new InventoryError(409, 'Order reservation request conflicts');
      if (hold && inserted.rowCount === 0 && !('saga_id' in request && request.saga_id)) throw new InventoryError(409, 'Existing reservation cannot be adopted');
      if (inserted.rowCount === 0) return this.group(input.orderId, await this.rows(client, [input.orderId]));
      const stocks = await this.lockStock(client, items.map((item) => item.productId));
      if (stocks.length !== items.length) throw new InventoryError(404, 'Inventory not found');
      const byId = new Map(stocks.map((stock) => [stock.productId, stock]));
      if (items.some((item) => byId.get(item.productId)!.availableStock < item.quantity)) {
        throw new InventoryError(409, 'Insufficient stock');
      }
      await client.query(`UPDATE inventory i SET reserved_stock = i.reserved_stock + item.quantity,
        updated_at = clock_timestamp() FROM UNNEST($1::uuid[], $2::integer[]) AS item(product_id, quantity)
        WHERE i.product_id = item.product_id`, [items.map((item) => item.productId), items.map((item) => item.quantity)]);
      await client.query(`WITH deadline AS (SELECT clock_timestamp() + $4::integer * INTERVAL '1 second' AS expires_at)
        INSERT INTO inventory_reservations (order_id, product_id, quantity, expires_at)
        SELECT $1::uuid, item.product_id, item.quantity, deadline.expires_at
        FROM UNNEST($2::uuid[], $3::integer[]) AS item(product_id, quantity) CROSS JOIN deadline`,
        [input.orderId, items.map((item) => item.productId), items.map((item) => item.quantity), this.ttlSeconds]);
      if (hold) await client.query('UPDATE inventory_reservations SET checkout_hold=TRUE WHERE order_id=$1',[input.orderId]);
      return this.group(input.orderId, await this.rows(client, [input.orderId]));
    };
    return transactionClient ? operation(transactionClient) : this.transaction(operation);
  }
  private async decreaseReserved(client: PoolClient, rows: ReservationRow[], consume: boolean) {
    const quantities = new Map<string, number>();
    for (const row of rows) quantities.set(row.product_id, (quantities.get(row.product_id) ?? 0) + row.quantity);
    if ([...quantities.values()].some((quantity) => !Number.isSafeInteger(quantity) || quantity > 2147483647)) throw new InventoryDatabaseError();
    await client.query(`UPDATE inventory i SET reserved_stock = i.reserved_stock - item.quantity,
      total_stock = i.total_stock - CASE WHEN $3::boolean THEN item.quantity ELSE 0 END,
      updated_at = clock_timestamp() FROM UNNEST($1::uuid[], $2::integer[]) AS item(product_id, quantity)
      WHERE i.product_id = item.product_id`, [[...quantities.keys()], [...quantities.values()], consume]);
  }
  async finish(orderId: string, target: 'CONFIRMED' | 'RELEASED', transactionClient?: PoolClient): Promise<ReservationGroup> {
    const operation = async (client: PoolClient) => {
      const request = await this.lockRequest(client, orderId);
      if (!transactionClient && 'saga_id' in request && request.saga_id) throw new InventoryError(409, 'Checkout reservation is managed by its Saga');
      const rows = await this.rows(client, [orderId]);
      const group = this.group(orderId, rows);
      if (target==='CONFIRMED' && 'fulfillment_blocked' in request && request.fulfillment_blocked) throw new InventoryError(409,'Fulfillment is blocked');
      if (group.status === target) return { group, expired: false };
      if (group.status !== 'RESERVED') throw new InventoryError(409, 'Invalid reservation state transition');
      await this.lockStock(client, rows.map((row) => row.product_id));
      // Recheck the database clock after waiting for all stock locks. One decision for all items.
      const changed = await client.query<{ status: ReservationStatus }>(`WITH decision AS MATERIALIZED (
        SELECT BOOL_OR(NOT checkout_hold AND expires_at <= clock_timestamp()) AS expired FROM inventory_reservations WHERE order_id = $1)
        UPDATE inventory_reservations SET status = CASE WHEN decision.expired THEN 'EXPIRED' ELSE $2::text END,
          updated_at = clock_timestamp() FROM decision WHERE order_id = $1 AND status = 'RESERVED' RETURNING status`, [orderId, target]);
      const status = changed.rows[0]?.status;
      if (changed.rowCount !== rows.length || !status) throw new InventoryDatabaseError();
      await this.decreaseReserved(client, rows, status === 'CONFIRMED');
      await client.query('UPDATE inventory_reservation_requests SET updated_at = clock_timestamp() WHERE order_id = $1', [orderId]);
      return { group: this.group(orderId, await this.rows(client, [orderId])), expired: status === 'EXPIRED' };
    };
    const result = transactionClient ? await operation(transactionClient) : await this.transaction(operation);
    // Keep the expiration/release committed even though the attempted late transition returns 409.
    if (result.expired) throw new InventoryError(409, 'Reservation has expired');
    return result.group;
  }
  async compensate(orderId:string,refundVerified:boolean,client:PoolClient):Promise<'RELEASED'|'RESTORED'|'ALREADY_RELEASED'|'ALREADY_EXPIRED'|'ALREADY_RESTORED'> {
    await this.lockRequest(client,orderId);
    const rows=await this.rows(client,[orderId]),group=this.group(orderId,rows);
    if(group.status==='RESERVED'){await this.finish(orderId,'RELEASED',client);return 'RELEASED';}
    if(group.status==='CONFIRMED'){
      if(!refundVerified)throw new InventoryError(409,'Confirmed stock requires verified refund authorization');
      await this.lockStock(client,rows.map(r=>r.product_id));
      await client.query(`UPDATE inventory i SET total_stock=i.total_stock+item.quantity,updated_at=clock_timestamp()
        FROM UNNEST($1::uuid[],$2::integer[]) AS item(product_id,quantity) WHERE i.product_id=item.product_id`,[rows.map(r=>r.product_id),rows.map(r=>r.quantity)]);
      await client.query("UPDATE inventory_reservations SET status='RESTORED',updated_at=clock_timestamp() WHERE order_id=$1 AND status='CONFIRMED'",[orderId]);return 'RESTORED';
    }
    return group.status==='RELEASED'?'ALREADY_RELEASED':group.status==='EXPIRED'?'ALREADY_EXPIRED':'ALREADY_RESTORED';
  }
  async expireBatch(batchSize = 100): Promise<number> {
    return this.transaction(async (client) => {
      const requests = await client.query<{ order_id: string }>(`SELECT r.order_id FROM inventory_reservation_requests r
        WHERE EXISTS (SELECT 1 FROM inventory_reservations i WHERE i.order_id = r.order_id
          AND i.status = 'RESERVED' AND NOT i.checkout_hold AND i.expires_at <= clock_timestamp())
        ORDER BY r.order_id LIMIT $1 FOR UPDATE OF r SKIP LOCKED`, [batchSize]);
      if (requests.rows.length === 0) return 0;
      const allRows = await this.rows(client, requests.rows.map((row) => row.order_id));
      const orderIds = requests.rows.filter((request) => {
        const rows = allRows.filter((row) => row.order_id === request.order_id);
        const group = this.group(request.order_id, rows);
        return group.status === 'RESERVED' && rows.some((row) => row.overdue);
      }).map((row) => row.order_id);
      if (orderIds.length === 0) return 0;
      const active = allRows.filter((row) => orderIds.includes(row.order_id));
      await this.lockStock(client, [...new Set(active.map((row) => row.product_id))]);
      const changed = await client.query(`UPDATE inventory_reservations SET status = 'EXPIRED', updated_at = clock_timestamp()
        WHERE order_id = ANY($1::uuid[]) AND status = 'RESERVED'`, [orderIds]);
      if (changed.rowCount !== active.length) throw new InventoryDatabaseError();
      await this.decreaseReserved(client, active, false);
      await client.query('UPDATE inventory_reservation_requests SET updated_at = clock_timestamp() WHERE order_id = ANY($1::uuid[])', [orderIds]);
      return orderIds.length;
    });
  }
}
