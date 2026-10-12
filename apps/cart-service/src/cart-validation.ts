import { z } from 'zod';
export const MAX_QUANTITY = 99;
export const productIdSchema = z.uuid().transform((id) => id.toLowerCase());
export const quantitySchema = z.number().int().min(1).max(MAX_QUANTITY);
export const addItemSchema = z.strictObject({ productId: productIdSchema, quantity: quantitySchema });
export const updateItemSchema = z.strictObject({ quantity: quantitySchema });
