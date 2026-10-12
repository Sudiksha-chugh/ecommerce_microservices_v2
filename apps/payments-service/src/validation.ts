import { z } from 'zod';
export const uuid = z.uuid().transform((id) => id.toLowerCase());
export const intentSchema = z.strictObject({ orderId: uuid, userId: uuid, amountPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.literal('INR') });
export const keySchema = z.string().min(1).max(255).refine((value) => !/[^\x21-\x7e]/.test(value), 'Must contain visible ASCII characters only');
export const emptyBody = z.strictObject({}).default({});
export type Intent = z.infer<typeof intentSchema>;
