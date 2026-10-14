import { z } from 'zod';

// Tokens refill as refillTokens / windowMs. The Lua balance uses integer token*windowMs units.
export const policySchema = z.object({
  capacity: z.number().int().min(1).max(1_000_000),
  refillTokens: z.number().int().min(1).max(1_000_000),
  windowMs: z.number().int().min(100).max(3_600_000),
}).strict().refine(p => Math.ceil(p.capacity * p.windowMs / p.refillTokens) <= 3_600_000,
  'A bucket must refill completely within one hour');
export type BucketPolicy = z.infer<typeof policySchema>;
const perMinute = (tokens: number): BucketPolicy => ({ capacity: tokens, refillTokens: tokens, windowMs: 60_000 });
export const defaultPolicies = {
  SEARCH: perMinute(120),
  GLOBAL_ANONYMOUS: perMinute(100), GLOBAL_AUTHENTICATED: perMinute(300),
  AUTH_LOGIN: perMinute(5), AUTH_REGISTER: perMinute(3),
  CHECKOUT_CREATE: perMinute(10), ORDER_CANCEL: perMinute(10), REFUND_CREATE: perMinute(5),
  ADMIN_OPERATIONS: perMinute(60), ADMIN_FINANCIAL: perMinute(10),
} satisfies Record<string, BucketPolicy>;
export type PolicyName = keyof typeof defaultPolicies;
export type Policies = Record<PolicyName, BucketPolicy>;
export const policyNames = Object.keys(defaultPolicies) as PolicyName[];
export function parsePolicyOverrides(json: string): Partial<Policies> {
  const shape = Object.fromEntries(policyNames.map(name => [name, policySchema.optional()]));
  return z.object(shape).strict().parse(JSON.parse(json)) as Partial<Policies>;
}
export interface RoutePolicy { names: PolicyName[]; forceIp: boolean; publicRead: boolean }
export function selectRoutePolicies(method: string, path: string, authenticated: boolean, admin: boolean): RoutePolicy {
  const route = path.toLowerCase().replace(/\/+$/, '');
  const auth = method === 'POST' && ['/auth/login', '/auth/register'].includes(route);
  const names: PolicyName[] = [authenticated && !auth ? 'GLOBAL_AUTHENTICATED' : 'GLOBAL_ANONYMOUS'];
  if (['GET','HEAD'].includes(method)&&route==='/search/products')names.push('SEARCH');
  if (auth) names.push(route === '/auth/login' ? 'AUTH_LOGIN' : 'AUTH_REGISTER');
  if (method === 'POST' && (route === '/checkout' || /^\/checkout\/[^/]+\/retry$/.test(route))) names.push('CHECKOUT_CREATE');
  if (method === 'POST' && /^\/orders\/[^/]+\/cancel$/.test(route)) names.push('ORDER_CANCEL');
  if (method === 'POST' && /^\/payments\/[^/]+\/refunds$/.test(route)) names.push('REFUND_CREATE');
  const financial = method === 'POST' && (route.startsWith('/payments/') && !names.includes('REFUND_CREATE'));
  if (financial) names.push('ADMIN_FINANCIAL');
  if (admin && !['GET', 'HEAD'].includes(method) && !auth) names.push('ADMIN_OPERATIONS');
  return { names, forceIp: auth, publicRead: ['GET', 'HEAD'].includes(method)
    && (route==='/search/products' || /^\/products(?:\/[^/]+)?$/.test(route) || /^\/inventory\/[^/]+$/.test(route)) };
}
