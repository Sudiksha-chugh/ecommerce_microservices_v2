import { describe, expect, it } from 'vitest';
import { loadCartEnvironment } from '@ecommerce/config';
const settings = { JWT_ISSUER: 'test-auth', JWT_AUDIENCE: 'test-api', JWT_PUBLIC_KEY_FILE: '/public.pem' };
describe('Cart environment configuration', () => {
  it('defaults to port 4002 and a seven-day TTL without database credentials or private keys', () => {
    const environment = loadCartEnvironment(settings);
    expect(environment.CART_PORT).toBe(4002);
    expect(environment.CART_TTL_SECONDS).toBe(604800);
    expect(environment.CART_REDIS_URL).toBe('redis://127.0.0.1:6379/0');
    expect(environment).not.toHaveProperty('PGPASSWORD');
    expect(environment).not.toHaveProperty('AUTH_JWT_PRIVATE_KEY_FILE');
  });
  it.each([
    { CART_TTL_SECONDS: '0' }, { CART_REDIS_URL: 'http://localhost' },
    { CART_REDIS_URL: 'redis://localhost/16' }, { CATALOG_SERVICE_URL: 'http://user:pass@localhost' },
    { JWT_ISSUER: '' }, { JWT_AUDIENCE: '' }, { JWT_PUBLIC_KEY_FILE: '' },
  ])('rejects invalid settings %j', (invalid) => {
    expect(() => loadCartEnvironment({ ...settings, ...invalid })).toThrow('Invalid Cart Service environment');
  });
});
