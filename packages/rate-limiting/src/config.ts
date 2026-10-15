import { z } from 'zod';
import { createProxyTrust } from './identity.js';
import { defaultPolicies, parsePolicyOverrides, type Policies } from './policies.js';
const bool = z.enum(['true', 'false']).transform(value => value === 'true');
const schema = z.object({
  RATE_LIMIT_ENABLED: bool.default(false),
  RATE_LIMIT_REDIS_URL: z.url().refine(value => {
    const url = new URL(value);
    return ['redis:', 'rediss:'].includes(url.protocol) && !url.search && !url.hash
      && /^\/(?:[0-9]|1[0-5])?$/.test(url.pathname || '/');
  }, 'Must be a standalone Redis URL (database 0–15)').default('redis://127.0.0.1:6380/0'),
  RATE_LIMIT_KEY_PREFIX: z.string().regex(/^ecommerce:v2:ratelimit:v[1-9][0-9]*(?::[a-zA-Z0-9_-]{1,64})?$/).default('ecommerce:v2:ratelimit:v1'),
  RATE_LIMIT_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(10).max(10_000).default(1000),
  RATE_LIMIT_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(10).max(5000).default(200),
  RATE_LIMIT_MAX_PENDING: z.coerce.number().int().min(1).max(1000).default(100),
  RATE_LIMIT_FAIL_OPEN_PUBLIC: bool.default(true),
  RATE_LIMIT_TRUSTED_PROXIES: z.string().max(4096).default(''),
  RATE_LIMIT_POLICY_OVERRIDES: z.string().max(8192).default('{}'),
  JWT_PUBLIC_KEY_FILE: z.string().trim().min(1).optional(),
  JWT_ISSUER: z.string().trim().min(1).optional(),
  JWT_AUDIENCE: z.string().trim().min(1).optional(),
}).superRefine((config, ctx) => {
  if (config.RATE_LIMIT_ENABLED) for (const key of ['JWT_PUBLIC_KEY_FILE', 'JWT_ISSUER', 'JWT_AUDIENCE'] as const)
    if (!config[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required when rate limiting is enabled' });
});
export type RateLimitConfig = z.infer<typeof schema> & { policies: Policies; trustedProxies: string[] };
export function loadRateLimitEnvironment(environment: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  try {
    const config = schema.parse(environment);
    const trustedProxies = config.RATE_LIMIT_TRUSTED_PROXIES.split(',').map(s => s.trim()).filter(Boolean);
    if (trustedProxies.length > 64) throw new Error();
    createProxyTrust(trustedProxies);
    return { ...config, trustedProxies, policies: { ...defaultPolicies, ...parsePolicyOverrides(config.RATE_LIMIT_POLICY_OVERRIDES) } };
  } catch { throw new Error('Invalid rate-limit configuration; check flags, bounds, policies, proxy CIDRs and JWT settings'); }
}
