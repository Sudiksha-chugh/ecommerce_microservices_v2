export type RedisErrorCode = 'UNAVAILABLE' | 'TIMEOUT' | 'SATURATED' | 'CLOSED' | 'CONFIGURATION';
export class RateLimitStoreError extends Error {
  constructor(readonly code: RedisErrorCode) { super('Rate-limit enforcement unavailable'); }
}
