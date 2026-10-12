import { z } from 'zod';

const commonEnvironment = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(10000),
};
const port = z.coerce.number().int().min(1).max(65535);
const host = z.string().trim().min(1);

const upstreamOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash;
}, 'Must be an HTTP(S) origin without credentials, path, query, or fragment');
const jwtEnvironment = {
  JWT_ISSUER: z.string().trim().min(1),
  JWT_AUDIENCE: z.string().trim().min(1),
  JWT_PUBLIC_KEY_FILE: z.string().trim().min(1),
};

const gatewayEnvironmentSchema = z.object({
  ...commonEnvironment,
  HOST: host.default('127.0.0.1'),
  PORT: port.default(3000),
  CATALOG_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4001'),
  INVENTORY_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4005'),
  INVENTORY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(10000),
  ORDERS_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4003'),
  ORDERS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(10000),
  CART_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4002'),
  CART_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(3000),
  AUTH_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4000'),
  AUTH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(3000),
  CATALOG_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(3000),
});

const catalogEnvironmentSchema = z.object({
  ...commonEnvironment,
  ...jwtEnvironment,
  CATALOG_HOST: host.default('127.0.0.1'),
  CATALOG_PORT: port.default(4001),
  PGHOST: host.default('127.0.0.1'),
  PGPORT: port.default(5432),
  PGDATABASE: z.literal('catalog_db').default('catalog_db'),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGPOOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  PGCONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  PGQUERY_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
});

export type GatewayEnvironment = z.infer<typeof gatewayEnvironmentSchema>;
export type CatalogEnvironment = z.infer<typeof catalogEnvironmentSchema>;

export function loadGatewayEnvironment(environment: NodeJS.ProcessEnv = process.env): GatewayEnvironment {
  const result = gatewayEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid API Gateway environment: ${issues.join('; ')}`);
  }
  return result.data;
}

export function loadCatalogEnvironment(environment: NodeJS.ProcessEnv = process.env): CatalogEnvironment {
  const result = catalogEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid Catalog Service environment: ${issues.join('; ')}`);
  }
  return result.data;
}

const authEnvironmentSchema = z.object({
  ...commonEnvironment, ...jwtEnvironment,
  AUTH_HOST: host.default('127.0.0.1'),
  AUTH_PORT: port.default(4000),
  AUTH_PGHOST: host.default('127.0.0.1'),
  AUTH_PGPORT: port.default(5432),
  AUTH_PGDATABASE: z.literal('auth_db').default('auth_db'),
  AUTH_PGUSER: z.string().min(1).default('auth_user'),
  AUTH_PGPASSWORD: z.string().min(1),
  AUTH_PGPOOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  AUTH_PGCONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  AUTH_PGQUERY_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  AUTH_JWT_PRIVATE_KEY_FILE: z.string().trim().min(1),
  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
});
export type AuthEnvironment = z.infer<typeof authEnvironmentSchema>;
export function loadAuthEnvironment(environment: NodeJS.ProcessEnv = process.env): AuthEnvironment {
  const result = authEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid Auth Service environment: ${issues.join('; ')}`);
  }
  return result.data;
}

const cartEnvironmentSchema = z.object({
  ...commonEnvironment, ...jwtEnvironment,
  CART_HOST: host.default('127.0.0.1'), CART_PORT: port.default(4002),
  CART_REDIS_URL: z.url().refine((value) => {
    const url = new URL(value);
    return ['redis:', 'rediss:'].includes(url.protocol) && !url.search && !url.hash
      && /^\/(?:[0-9]|1[0-5])?$/.test(url.pathname || '/');
  }, 'Must be a Redis URL with database index 0–15 and no query or fragment').default('redis://127.0.0.1:6379/0'),
  CART_TTL_SECONDS: z.coerce.number().int().min(1).max(31536000).default(604800),
  CART_REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  CART_REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  CATALOG_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4001'),
  CATALOG_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(2000),
});
export type CartEnvironment = z.infer<typeof cartEnvironmentSchema>;
export function loadCartEnvironment(environment: NodeJS.ProcessEnv = process.env): CartEnvironment {
  const result = cartEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid Cart Service environment: ${issues.join('; ')}`);
  }
  return result.data;
}

const ordersEnvironmentSchema = z.object({
  ...commonEnvironment, ...jwtEnvironment,
  ORDERS_HOST: host.default('127.0.0.1'), ORDERS_PORT: port.default(4003),
  ORDERS_PGHOST: host.default('127.0.0.1'), ORDERS_PGPORT: port.default(5432),
  ORDERS_PGDATABASE: z.literal('orders_db').default('orders_db'),
  ORDERS_PGUSER: z.string().min(1).default('orders_user'), ORDERS_PGPASSWORD: z.string().min(1),
  ORDERS_PGPOOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  ORDERS_PGCONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  ORDERS_PGQUERY_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  CART_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4002'),
  CART_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(2000),
  CATALOG_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4001'),
  CATALOG_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(2000),
});
export type OrdersEnvironment = z.infer<typeof ordersEnvironmentSchema>;
export function loadOrdersEnvironment(environment: NodeJS.ProcessEnv = process.env): OrdersEnvironment {
  const result = ordersEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid Orders Service environment: ${issues.join('; ')}`);
  }
  return result.data;
}

const inventoryEnvironmentSchema = z.object({
  ...commonEnvironment, ...jwtEnvironment,
  INVENTORY_HOST: host.default('127.0.0.1'), INVENTORY_PORT: port.default(4005),
  INVENTORY_PGHOST: host.default('127.0.0.1'), INVENTORY_PGPORT: port.default(5432),
  INVENTORY_PGDATABASE: z.literal('inventory_db').default('inventory_db'),
  INVENTORY_PGUSER: z.string().min(1).default('inventory_user'), INVENTORY_PGPASSWORD: z.string().min(1),
  INVENTORY_PGPOOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  INVENTORY_PGCONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  INVENTORY_PGQUERY_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(2000),
  CATALOG_SERVICE_URL: upstreamOrigin.default('http://127.0.0.1:4001'),
  CATALOG_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(2000),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(604800).default(900),
  EXPIRATION_WORKER_INTERVAL_MS: z.coerce.number().int().min(50).max(60000).default(5000),
  EXPIRATION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
});
export type InventoryEnvironment = z.infer<typeof inventoryEnvironmentSchema>;
export function loadInventoryEnvironment(environment: NodeJS.ProcessEnv = process.env): InventoryEnvironment {
  const result = inventoryEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid Inventory Service environment: ${issues.join('; ')}`);
  }
  return result.data;
}
