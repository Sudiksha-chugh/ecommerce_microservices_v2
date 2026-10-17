import type { Cart } from '@ecommerce/contracts';
import type { CartRedisClient } from './redis/client.js';
import { addItemScript, updateItemScript, removeItemScript } from './redis/scripts.js';
import { MAX_QUANTITY, productIdSchema, quantitySchema } from './cart-validation.js';
import { CartError } from './errors.js';

export class CartRepository {
  constructor(
    private readonly client: CartRedisClient, private readonly ttlSeconds: number,
    private readonly commandTimeoutMs = 2000, private readonly prefix = 'cart:',
  ) {}
  key(userId: string): string { return `${this.prefix}{${userId}}`; }
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.client.isReady) throw new Error('Redis not ready');
      // The Redis queue timeout ends when the command is written. Bound the
      // entire response wait as well, including an established socket blackhole.
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CartError(503, 'Cart storage unavailable')), this.commandTimeoutMs);
      })]);
    } catch (error) {
      if (error instanceof CartError) throw error;
      throw new CartError(503, 'Cart storage unavailable');
    } finally { clearTimeout(timer); }
  }
  private commands() { return this.client.withCommandOptions({ timeout: this.commandTimeoutMs }); }
  private cart(pairs: unknown): Cart {
    if (!Array.isArray(pairs) || pairs.length % 2 !== 0) throw new Error('Invalid cart storage');
    const items: Cart['items'] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const productId = productIdSchema.parse(pairs[i]);
      const quantity = quantitySchema.parse(Number(pairs[i + 1]));
      items.push({ productId, quantity });
    }
    return { items: items.sort((a, b) => a.productId.localeCompare(b.productId)) };
  }
  async find(userId: string): Promise<Cart> {
    return this.execute(async () => {
      const hash = await this.commands().hGetAll(this.key(userId));
      return this.cart(Object.entries(hash).flat());
    });
  }
  async add(userId: string, productId: string, quantity: number): Promise<Cart> {
    return this.execute(async () => {
      const result = await this.commands().eval(addItemScript, {
        keys: [this.key(userId)], arguments: [productId, String(quantity), String(MAX_QUANTITY), String(this.ttlSeconds)],
      });
      if (!Array.isArray(result)) throw new Error('Invalid cart storage');
      if (result[0] === -1) throw new CartError(400, `Cart item quantity cannot exceed ${MAX_QUANTITY}`);
      if (result[0] !== 1) throw new Error('Invalid cart storage');
      return this.cart(result[1]);
    });
  }
  async update(userId: string, productId: string, quantity: number): Promise<Cart> {
    return this.execute(async () => {
      const result = await this.commands().eval(updateItemScript, {
        keys: [this.key(userId)], arguments: [productId, String(quantity), String(this.ttlSeconds)],
      });
      if (!Array.isArray(result)) throw new Error('Invalid cart storage');
      if (result[0] === 0) throw new CartError(404, 'Cart item not found');
      if (result[0] !== 1) throw new Error('Invalid cart storage');
      return this.cart(result[1]);
    });
  }
  async remove(userId: string, productId: string): Promise<void> {
    return this.execute(async () => {
      const removed = await this.commands().eval(removeItemScript, {
        keys: [this.key(userId)], arguments: [productId, String(this.ttlSeconds)],
      });
      if (removed === 0) throw new CartError(404, 'Cart item not found');
      if (removed !== 1) throw new Error('Invalid cart storage');
    });
  }
  async clear(userId: string): Promise<void> {
    await this.execute(async () => { await this.commands().del(this.key(userId)); });
  }
}
