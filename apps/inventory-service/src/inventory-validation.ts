import { z } from 'zod';
export const uuidSchema = z.uuid().transform((id) => id.toLowerCase());
export const stockSchema = z.strictObject({ totalStock: z.number().int().min(0).max(2147483647) });
export const reservationSchema = z.strictObject({
  orderId: uuidSchema,
  items: z.array(z.strictObject({ productId: uuidSchema, quantity: z.number().int().min(1).max(2147483647) })).min(1).max(100),
}).refine((input) => new Set(input.items.map((item) => item.productId)).size === input.items.length,
  'Duplicate product IDs').transform((input) => ({ ...input, items: input.items.sort((a, b) => a.productId.localeCompare(b.productId)) }));
export const emptyBodySchema = z.strictObject({}).default({});
export type ReservationInput = z.infer<typeof reservationSchema>;
