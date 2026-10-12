import { z } from 'zod';

const fields = {
  name: z.string().trim().min(1).max(255),
  description: z.string(),
  priceInPaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};

export const productIdSchema = z.uuid();
export const createProductSchema = z.strictObject(fields);
export const updateProductSchema = createProductSchema.partial().refine(
  (body) => Object.keys(body).length > 0, 'At least one field is required',
);
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
