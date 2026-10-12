import type { CartRepository } from './cart-repository.js';
import type { CatalogClient } from './catalog-client.js';

export class CartService {
  constructor(private readonly carts: CartRepository, private readonly catalog: CatalogClient) {}
  find(userId: string) { return this.carts.find(userId); }
  async add(userId: string, productId: string, quantity: number) {
    await this.catalog.requireProduct(productId);
    return this.carts.add(userId, productId, quantity);
  }
  update(userId: string, productId: string, quantity: number) { return this.carts.update(userId, productId, quantity); }
  remove(userId: string, productId: string) { return this.carts.remove(userId, productId); }
  clear(userId: string) { return this.carts.clear(userId); }
}
