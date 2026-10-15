import {telemetryFetch} from '@ecommerce/observability';
import { cartSchema, productSchema } from './order-validation.js';
import { OrderError } from './errors.js';

async function getJson(origin: string, path: string, service: 'Cart' | 'Catalog', timeoutMs: number, authorization?: string): Promise<unknown> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await telemetryFetch(new URL(path, origin), {
      signal: controller.signal, redirect: 'error',
      headers: { accept: 'application/json', ...(authorization ? { authorization } : {}) },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (service === 'Catalog' && response.status === 404) throw new OrderError(422, 'Cart product is unavailable');
      throw new OrderError(502, `${service} Service unavailable`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new OrderError(504, `${service} Service request timed out`);
    if (error instanceof OrderError) throw error;
    throw new OrderError(502, `${service} Service unavailable`);
  } finally { clearTimeout(deadline); }
}
export class CartClient {
  constructor(private readonly origin: string, private readonly timeoutMs: number) {}
  async getCart(authorization: string) {
    const result = cartSchema.safeParse(await getJson(this.origin, '/cart', 'Cart', this.timeoutMs, authorization));
    if (!result.success) {
      if (result.error.issues.some((issue) => issue.code === 'too_big' && issue.path[0] === 'items')) {
        throw new OrderError(422, 'Cart exceeds 100-item checkout limit');
      }
      throw new OrderError(502, 'Invalid Cart Service response');
    }
    return result.data;
  }
}
export class CatalogClient {
  constructor(private readonly origin: string, private readonly timeoutMs: number) {}
  async getProduct(productId: string) {
    const result = productSchema.safeParse(await getJson(this.origin, `/products/${encodeURIComponent(productId)}`, 'Catalog', this.timeoutMs));
    if (!result.success || result.data.id !== productId) throw new OrderError(502, 'Invalid Catalog Service response');
    return result.data;
  }
}
