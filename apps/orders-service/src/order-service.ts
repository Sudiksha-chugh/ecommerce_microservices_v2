import type {SagaKeys} from '@ecommerce/messaging';
import { createHash } from 'node:crypto';
import type { OrderItem } from '@ecommerce/contracts';
import type { CartClient, CatalogClient } from './http-clients.js';
import type { OrderRepository } from './order-repository.js';
import { safeMoney } from './money.js';
import { OrderError } from './errors.js';

export class OrderService {
  constructor(private readonly orders: OrderRepository, private readonly cart: CartClient, private readonly catalog: CatalogClient) {}
  async create(userId: string, key: string, authorization: string, checkoutKeys?: SagaKeys) {
    const existing = await this.orders.findByKey(userId, key);
    if (existing) return existing.order; // Completed retries never inspect a changed cart or current prices.
    const cart = await this.cart.getCart(authorization);
    if (cart.items.length === 0) throw new OrderError(422, 'Cart is empty');
    // Input is bounded to 100 items; independent GETs run concurrently with individual deadlines.
    const items: OrderItem[] = await Promise.all(cart.items.map(async (item) => {
      const product = await this.catalog.getProduct(item.productId);
      try {
        return { productId: product.id, productName: product.name, unitPriceInPaise: product.priceInPaise,
          quantity: item.quantity, lineTotalInPaise: safeMoney(BigInt(product.priceInPaise) * BigInt(item.quantity)) };
      } catch { throw new OrderError(422, 'Order amount exceeds supported range'); }
    }));
    items.sort((a, b) => a.productId.localeCompare(b.productId));
    let totalAmountInPaise: number;
    try { totalAmountInPaise = safeMoney(items.reduce((total, item) => total + BigInt(item.lineTotalInPaise), 0n)); }
    catch { throw new OrderError(422, 'Order amount exceeds supported range'); }
    const snapshot = { items, totalAmountInPaise };
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: 1, ...snapshot })).digest('hex');
    return this.orders.create(userId, key, fingerprint, snapshot, checkoutKeys);
  }
  findAll(userId: string, limit: number, offset: number) { return this.orders.findAll(userId, limit, offset); }
  findById(userId: string, id: string) { return this.orders.findById(userId, id); }
}
