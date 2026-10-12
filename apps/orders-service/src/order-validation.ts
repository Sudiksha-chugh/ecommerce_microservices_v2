import { z } from 'zod';
export const orderIdSchema = z.uuid().transform((id) => id.toLowerCase());
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/);
// Cart and authoritative prices come from services, never the request body.
export const createOrderBodySchema = z.strictObject({}).default({});
const integerQuery = z.string().regex(/^\d+$/).transform(Number);
export const paginationSchema = z.strictObject({
  limit: integerQuery.pipe(z.number().int().min(1).max(100)).default(20),
  offset: integerQuery.pipe(z.number().int().min(0).max(1000000)).default(0),
});
export const cartSchema = z.object({
  items: z.array(z.object({
    productId: orderIdSchema, quantity: z.number().int().min(1).max(99),
  })).max(100),
}).refine((cart) => new Set(cart.items.map((item) => item.productId)).size === cart.items.length);
export const productSchema = z.object({
  id: orderIdSchema, name: z.string().min(1).max(255),
  priceInPaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
