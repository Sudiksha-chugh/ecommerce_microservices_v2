import { describe, expect, it } from 'vitest';
import { loadOrdersEnvironment } from '@ecommerce/config';
const settings = { JWT_ISSUER: 'test-auth', JWT_AUDIENCE: 'test-api', JWT_PUBLIC_KEY_FILE: '/public.pem', ORDERS_PGPASSWORD: 'test-only' };
describe('Orders configuration', () => {
  it('uses its own database, public key only, and port 4003', () => {
    const environment = loadOrdersEnvironment(settings);
    expect(environment.ORDERS_PORT).toBe(4003); expect(environment.ORDERS_PGDATABASE).toBe('orders_db');
    expect(environment).not.toHaveProperty('AUTH_JWT_PRIVATE_KEY_FILE');
    expect(environment).not.toHaveProperty('CART_REDIS_URL');
    expect(environment).not.toHaveProperty('PGPASSWORD');
  });
  it.each([{ ORDERS_PGDATABASE: 'catalog_db' }, { ORDERS_PGDATABASE: 'auth_db' }, { ORDERS_PGPASSWORD: '' },
    { CART_SERVICE_URL: 'http://user:pass@localhost' }, { CATALOG_SERVICE_URL: 'ftp://localhost' }, { JWT_ISSUER: '' }])
    ('rejects invalid settings %j', (invalid) => expect(() => loadOrdersEnvironment({ ...settings, ...invalid })).toThrow('Invalid Orders Service environment'));
});
