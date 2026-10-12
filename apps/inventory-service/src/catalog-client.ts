import { InventoryError } from './errors.js';

export class CatalogClient {
  constructor(private readonly origin: string, private readonly timeoutMs: number) {}
  async requireProduct(productId: string): Promise<void> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(`/products/${encodeURIComponent(productId)}`, this.origin), {
        signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' },
      });
      await response.body?.cancel();
      if (response.status === 404) throw new InventoryError(404, 'Product not found');
      if (response.status !== 200) throw new InventoryError(502, 'Catalog Service unavailable');
    } catch (error) {
      if (controller.signal.aborted) throw new InventoryError(504, 'Catalog Service request timed out');
      if (error instanceof InventoryError) throw error;
      throw new InventoryError(502, 'Catalog Service unavailable');
    } finally { clearTimeout(deadline); }
  }
}
