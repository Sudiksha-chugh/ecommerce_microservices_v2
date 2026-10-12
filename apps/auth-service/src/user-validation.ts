import { z } from 'zod';
const email = z.string().trim().toLowerCase().pipe(z.email().max(255));
export const registrationSchema = z.strictObject({ email, password: z.string().min(12).max(128) });
export const loginSchema = z.strictObject({ email, password: z.string().min(1).max(128) });
export type Credentials = z.infer<typeof registrationSchema>;
